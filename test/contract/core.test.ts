// Item 6 契約測試：金流核心語意（窗口歸集 / OCC / Exactly-Once 冪等 / 審計位元組相容 / alarm 兜底）。
// 使用 @cloudflare/vitest-plugin：SELF 走完整 worker 整合；runDurableObjectAlarm 模擬 alarm。
import { describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import { WINDOW_MS } from '../../src/platform/account-do';
import type { Env } from '../../src/platform/env';
import { unpackMicroUAC } from '../../src/shared/microuac';
import { md5 } from '../../src/platform/md5';
import { OperationType, type TransactionInput } from '../../src/shared/types';

const e = env as unknown as Env;

const T = (transactionId: string, amount: number, operationType = OperationType.Credit, referenceId?: string): TransactionInput => ({
  transactionId,
  operationType,
  amount,
  referenceId,
});

async function postTxn(accountId: string, txn: TransactionInput): Promise<Response> {
  return SELF.fetch(`https://example.com/accounts/${accountId}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(txn),
  });
}

async function getAccount(accountId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await SELF.fetch(`https://example.com/accounts/${accountId}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function forceFlush(accountId: string): Promise<void> {
  const stub = e.ACCOUNT_DO.get(e.ACCOUNT_DO.idFromName(accountId));
  const res = await stub.fetch('https://do/flush', {
    method: 'POST',
    body: JSON.stringify({ type: 'flush', accountId }),
  });
  await res.json();
}

async function auditRows(accountId: string): Promise<{ bytes: Uint8Array; status: string }[]> {
  const rows = await e.DB.prepare('SELECT micro_uac, status FROM audit WHERE account_id = ? ORDER BY id')
    .bind(accountId)
    .all<{ micro_uac: ArrayBuffer; status: string }>();
  return rows.results.map((r) => ({ bytes: new Uint8Array(r.micro_uac as unknown as ArrayBuffer), status: r.status }));
}

describe('金流核心契約（Item 6）', () => {
  it('同窗口多筆交易歸集為批次原子提交：餘額/版本/審計一致', async () => {
    const acc = 'acc-window-1';
    const txns: Array<[string, number]> = [['t1', 100], ['t2', 30], ['t3', 5]];
    for (const [id, amt] of txns) {
      const res = await postTxn(acc, T(id, amt));
      expect(res.status).toBe(202);
    }
    await forceFlush(acc);
    const { status, json } = await getAccount(acc);
    expect(status).toBe(200);
    expect(json.balance).toBe(135); // 100+30+5
    expect((json.version as number) >= 1).toBe(true);
    expect(json.auditCount).toBe(3);
    expect(json.processedCount).toBe(3);

    // 審計 48-byte 可解碼、status=Committed（原子一致：審計筆數 == 已處理筆數 == 餘額增量）
    const rows = await auditRows(acc);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe('Committed');
      expect(r.bytes.length).toBe(48);
      const u = unpackMicroUAC(r.bytes);
      expect(typeof u.transactionId).toBe('bigint');
      expect(u.amount).toBeTypeOf('bigint');
      expect(u.reserved?.length).toBe(5);
    }
  });

  it('Exactly-Once：同 transactionId 重送只套用一次（冪等去重）', async () => {
    const acc = 'acc-idem-1';
    await postTxn(acc, T('dup-1', 100));
    await forceFlush(acc);
    await postTxn(acc, T('dup-1', 100)); // 跨窗口重送
    await forceFlush(acc);
    const { json } = await getAccount(acc);
    expect(json.balance).toBe(100);
    expect(json.processedCount).toBe(1);
    expect(json.auditCount).toBe(1);
  });

  it('並發收單到同一帳戶由 DO 串行化（Hot Account），最終餘額正確', async () => {
    const acc = 'acc-conc-1';
    await Promise.all([1, 2, 3, 4, 5].map((i) => postTxn(acc, T(`c${i}`, 10))));
    // 最終一致輪詢：並發 POST 可能在 forceFlush 到達 DO 前仍在排隊（輸入閘），
    // 落進下一窗口由 alarm/後續 flush 提交——輪詢直到全部入帳（比照來源 e2e「等 version==K」）
    let balance = 0;
    let processed = 0;
    for (let i = 0; i < 20; i++) {
      await forceFlush(acc);
      const { json } = await getAccount(acc);
      balance = json.balance as number;
      processed = json.processedCount as number;
      if (balance === 50 && processed === 5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(balance).toBe(50);
    expect(processed).toBe(5);
    const { json } = await getAccount(acc);
    expect(json.auditCount).toBe(5);
  });

  it('審計 MicroUAC 位元組相容：transactionId 前 8 bytes MD5 收斂、referenceHash = MD5(referenceId)', async () => {
    const acc = 'acc-uac-1';
    await postTxn(acc, T('uac-1', 77, OperationType.Debit, 'ref-abc'));
    await forceFlush(acc);
    const rows = await auditRows(acc);
    expect(rows).toHaveLength(1);
    const u = unpackMicroUAC(rows[0].bytes);

    // transactionId = MD5(transactionId) 前 8 bytes 的 big-endian Int64（來源 microUacFor 語意）
    const txHash = md5('uac-1');
    const view = new DataView(txHash.buffer);
    expect(u.transactionId).toBe(view.getBigInt64(0));
    // referenceHash = MD5(referenceId)
    expect([...u.referenceHash]).toEqual([...md5('ref-abc')]);
    // 欄位語意
    expect(u.operationType).toBe(OperationType.Debit);
    expect(u.amount).toBe(77n);
    expect(u.sequenceNumber).toBe(1);
    expect(u.accountVersion).toBe(1);
  });

  it('alarm 兜底 flush：窗口到期未收到新請求仍會提交（lazy flush 失敗路徑）', async () => {
    const acc = 'acc-alarm-1';
    await postTxn(acc, T('a1', 42));
    // 等待窗口 deadline 過去（alarm 精確度不保證，兜底語意：延遲後仍提交）
    await new Promise((r) => setTimeout(r, WINDOW_MS + 80));
    const stub = e.ACCOUNT_DO.get(e.ACCOUNT_DO.idFromName(acc));
    await runDurableObjectAlarm(stub);
    const { json } = await getAccount(acc);
    expect(json.balance).toBe(42);
    expect(json.processedCount).toBe(1);
    expect(json.auditCount).toBe(1);
  });

  it('種子帳戶 hot-account-1 可直接收單（migration 種子）', async () => {
    const res = await postTxn('hot-account-1', T('h1', 5));
    expect(res.status).toBe(202);
    await forceFlush('hot-account-1');
    const { json } = await getAccount('hot-account-1');
    expect(json.balance).toBe(5);
    expect(json.version).toBe(1);
  });

  it('無效交易回 400', async () => {
    const bad1 = await postTxn('acc-bad-1', { transactionId: '', operationType: OperationType.Credit, amount: 10 } as unknown as TransactionInput);
    expect(bad1.status).toBe(400);
    const bad2 = await postTxn('acc-bad-1', { transactionId: 'x', operationType: 99, amount: 10 } as unknown as TransactionInput);
    expect(bad2.status).toBe(400);
    const bad3 = await postTxn('acc-bad-1', { transactionId: 'x', operationType: OperationType.Credit, amount: -5 } as unknown as TransactionInput);
    expect(bad3.status).toBe(400);
  });

  it('不存在的帳戶 GET 回 404', async () => {
    const { status } = await getAccount('no-such-account');
    expect(status).toBe(404);
  });
});
