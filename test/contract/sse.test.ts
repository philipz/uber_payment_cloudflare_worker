// Item 8 契約測試：SSE 儀表板 + 領域事件廣播（EVENTS_CHANNEL 語意的 Worker 對應）。
//
// 設計（來源 Redis pub/sub → Worker）：
//   - EventHub DO（單一 hub 實例 idFromName('hub')）取代 Redis pub/sub：
//     SSE 客戶端 GET /events 訂閱 hub；AccountDO commit 成功後 POST /publish 事件；
//     hub fan-out `data: <JSON>\n\n` 給所有已連線 SSE 客戶端。
//   - /dashboard 回 DASHBOARD_HTML（來源 batch-creator/dashboard.ts 移植，純靜態資產）。
//
// H7 核可（issue #34 留言）：路由 /events、/dashboard 與事件 payload 格式
// `data: <DomainEvent JSON>\n\n` 已由人類核可；AccountDO 僅新增發布 hook（零計算改動）。
import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { OperationType, TxnState, type TransactionInput } from '../../src/shared/types';
import type { Env } from '../../src/platform/env';
import { formatSseData } from '../../src/shared/events';

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

async function forceFlush(accountId: string): Promise<void> {
  const stub = e.ACCOUNT_DO.get(e.ACCOUNT_DO.idFromName(accountId));
  const res = await stub.fetch('https://do/flush', {
    method: 'POST',
    body: JSON.stringify({ type: 'flush', accountId }),
  });
  await res.json();
}

/** 讀 SSE stream 直到收到包含 needle 的 chunk（timeout 保護，避免測試 hang）。 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done?: boolean }>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout waiting for "${needle}" in SSE stream; got: ${acc}`)),
          3000,
        );
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (read.done) break;
    acc += decoder.decode(read.value, { stream: true });
    if (acc.includes(needle)) return acc;
  }
  throw new Error(`timeout waiting for "${needle}" in SSE stream; got: ${acc}`);
}

describe('SSE 儀表板契約（Item 8，H7 人類核可）', () => {
  it('/dashboard 回 HTML（200 + text/html + 含 EventSource 訂閱）', async () => {
    const res = await SELF.fetch('https://example.com/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('EventSource');
    expect(html).toContain('/events');
  });

  it('/events 回 SSE stream（200 + text/event-stream）', async () => {
    const res = await SELF.fetch('https://example.com/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).toBeInstanceOf(ReadableStream);
    await res.body?.cancel();
  });

  it('訂閱 /events 後，交易提交（forceFlush）收到 Committed 事件（payload 含 accountId/batchId/version/balance）', async () => {
    const acc = 'acc-sse-1';
    const res = await SELF.fetch('https://example.com/events');
    const reader = res.body!.getReader();

    const post = await postTxn(acc, T('sse-1', 100));
    expect(post.status).toBe(202);
    await forceFlush(acc);

    const chunk = await readUntil(reader, 'Committed');
    await reader.cancel();

    // SSE 格式：data: <JSON>\n\n（與來源 EVENTS_CHANNEL payload 一致）
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    expect(line).toBeDefined();
    const event = JSON.parse(line!.slice('data: '.length)) as {
      state: string;
      accountId: string;
      batchId?: string;
      version?: number;
      balance?: number;
    };
    expect(event.state).toBe(TxnState.Committed);
    expect(event.accountId).toBe(acc);
    // batchId = `${accountId}:${windowStart}`（account-do flush 組批語意）
    expect(event.batchId).toMatch(new RegExp(`^${acc}:\\d+$`));
    expect(typeof event.version).toBe('number');
    expect(event.balance).toBe(100);
  });

  it('formatSseData 純函式：data: <JSON>\\n\\n 格式', () => {
    const event = { ts: 1234, state: TxnState.Committed, accountId: 'a', batchId: 'b', version: 1, balance: 5 };
    const s = formatSseData(event);
    expect(s).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});
