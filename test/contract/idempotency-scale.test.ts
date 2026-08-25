// Item 12 擴展性回歸測試：commitBatch 冪等查詢改為「只查本批次」後，帳戶有大量歷史
// processed 時仍正確去重、不退化。
//
// 背景（docs/diagnosis-500-idempotency.md）：原實作用 WHERE account_id = ? 全量讀
// 帳戶所有 processed——單帳戶累積越多，每次 commit 查詢越大，最終平台層 500。
// 修復：只查本批次的 transaction_id（回歸來源 ANY($1) 語意）。
//
// 本測試驗證：
//   1. 帳戶已有大量歷史交易（模擬累積）後，新批次交易仍被正確提交
//   2. 新批次內含歷史已處理的 transaction_id → 仍被冪等去重（不重複套用）
//   3. 批次內重複 → 仍去重
import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { OperationType, type TransactionInput } from '../../src/shared/types';
import type { Env } from '../../src/platform/env';

const e = env as unknown as Env;

const T = (transactionId: string, amount: number, operationType = OperationType.Credit): TransactionInput => ({
  transactionId,
  operationType,
  amount,
});

async function postTxn(accountId: string, txn: TransactionInput): Promise<Response> {
  return SELF.fetch(`https://example.com/accounts/${accountId}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(txn),
  });
}

async function forceFlush(accountId: string): Promise<void> {
  const stub = e.ACCOUNT_DO.get(e.ACCOUNT_DO.idFromName(accountId));
  const res = await stub.fetch('https://do/flush', {
    method: 'POST',
    body: JSON.stringify({ type: 'flush', accountId }),
  });
  await res.json();
}

async function getAccount(accountId: string): Promise<{ balance: number; processedCount: number; auditCount: number }> {
  const res = await SELF.fetch(`https://example.com/accounts/${accountId}`);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    balance: json.balance as number,
    processedCount: json.processedCount as number,
    auditCount: json.auditCount as number,
  };
}

describe('commitBatch 冪等查詢擴展性（Item 12，H2 人類主導）', () => {
  /** 最終一致輪詢：forceFlush 前 POST 可能在輸入佇列，輪詢直到預期筆數（比照 core.test.ts 先例）。 */
  async function waitFor(accountId: string, expectedProcessed: number, maxTries = 30): Promise<{ balance: number; processedCount: number; auditCount: number }> {
    let s = { balance: 0, processedCount: 0, auditCount: 0 };
    for (let i = 0; i < maxTries; i++) {
      await forceFlush(accountId);
      s = await getAccount(accountId);
      if (s.processedCount >= expectedProcessed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return s;
  }

  it('帳戶累積大量歷史交易後，新批次仍正常提交（不退化）', async () => {
    const acc = 'acc-scale-1';
    // 第一輪：逐筆 post + flush（單筆單窗口）確保 100 筆全部落庫——建立大量歷史
    for (let i = 0; i < 100; i++) {
      await postTxn(acc, T(`hist-${i}`, 1));
      await forceFlush(acc);
    }
    let s = await getAccount(acc);
    expect(s.processedCount).toBe(100); // 100 筆歷史

    // 第二輪：新批次交易（帳戶已有 100 筆歷史）——逐筆 post + flush 確保全數入帳
    // （避免批量 post 最後一筆在輸入佇列落入下一窗口的時序 flake）
    for (let i = 0; i < 20; i++) {
      await postTxn(acc, T(`new-${i}`, 1));
      await forceFlush(acc);
    }
    s = await getAccount(acc);
    expect(s.processedCount).toBe(120);
    expect(s.auditCount).toBe(120);
    expect(s.balance).toBe(120);
  });

  it('歷史已處理的 transaction_id 重送 → 仍被冪等去重（不重複套用）', async () => {
    const acc = 'acc-scale-2';
    // 建立歷史
    await postTxn(acc, T('legacy-1', 50));
    await forceFlush(acc);
    // 新批次含「歷史已處理」+「全新」交易
    await postTxn(acc, T('legacy-1', 999)); // 重送歷史（應去重，金額 999 不套用）
    await postTxn(acc, T('fresh-1', 7));
    await forceFlush(acc);

    const s = await waitFor(acc, 2);
    expect(s.processedCount).toBe(2); // legacy-1 + fresh-1
    expect(s.balance).toBe(57); // 50 + 7（legacy-1 重送被去重）
    expect(s.auditCount).toBe(2);
  });

  it('批次內重複 transaction_id → 仍去重（套用一次）', async () => {
    const acc = 'acc-scale-3';
    await postTxn(acc, T('dup-in-batch', 10));
    await postTxn(acc, T('dup-in-batch', 99)); // 同批次重複
    await forceFlush(acc);

    const s = await waitFor(acc, 1);
    expect(s.processedCount).toBe(1);
    expect(s.balance).toBe(10); // 只套 10，不套 99
  });
});
