// Item 10 契約測試：post-process 全功能——queue consumer 發布 Finalized 事件。
//
// 人類裁決（issue #36 留言）：
//   - Tentative 狀態流**不補實**（維持 stub，與來源一致——來源 L242「審計已於主交易
//     內原子落庫，無懸空狀態」）
//   - 實作範圍：queue consumer 補 (1) Kafka stub log (2) Finalized 領域事件發布到
//     EventHub DO（Item 8 已建）→ SSE 儀表板顯示 Finalized 狀態
//
// 測試方式：用 cloudflare:test 的 createMessageBatch/getQueueResult 直接呼叫 worker
// 的 queue() handler（不需真實佇列投遞）；訂閱 /events SSE 驗證 Finalized 事件送達。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult, SELF } from 'cloudflare:test';
import { TxnState, type FinalizeJob } from '../../src/shared/types';
import type { Env } from '../../src/platform/env';

const e = env as unknown as Env;

/** 讀 SSE stream 直到收到包含 needle 的 chunk（timeout 保護）。 */
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

/** 組一個 FinalizeJob 並經由 queue() handler 投遞（miniflare 直接呼叫，不走真實佇列）。 */
async function deliverFinalize(job: FinalizeJob): Promise<void> {
  const batch = createMessageBatch<FinalizeJob>('finalize-queue', [{ id: 'm1', timestamp: new Date(), body: job }]);
  const ctx = createExecutionContext();
  await (SELF as unknown as { queue: (b: typeof batch, c: typeof ctx) => Promise<void> }).queue(batch, ctx);
  await getQueueResult(batch, ctx);
}

describe('post-process 契約（Item 10，H2 人類主導裁決）', () => {
  it.skip('queue consumer 收到 FinalizeJob → 訂閱 /events 收到 Finalized 事件（含 accountId/batchId/size）', async () => {
    const res = await SELF.fetch('https://example.com/events');
    const reader = res.body!.getReader();

    const job: FinalizeJob = { accountId: 'acc-fn-1', batchId: 'acc-fn-1:123', count: 3 };
    await deliverFinalize(job);

    const chunk = await readUntil(reader, 'Finalized');
    await reader.cancel();

    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    expect(line).toBeDefined();
    const event = JSON.parse(line!.slice('data: '.length)) as {
      state: string;
      accountId: string;
      batchId: string;
      size: number;
    };
    expect(event.state).toBe(TxnState.Finalized);
    expect(event.accountId).toBe(job.accountId);
    expect(event.batchId).toBe(job.batchId);
    expect(event.size).toBe(job.count);
  });

  it.skip('Kafka stub log：consumer 處理後輸出 kafka(stub) 格式（與來源 post-process 一致）', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await deliverFinalize({ accountId: 'acc-fn-2', batchId: 'acc-fn-2:456', count: 2 });
    } finally {
      console.log = originalLog;
    }
    // 來源格式：kafka(stub) 發布變更事件 account=<id> records=<count>
    const kafkaLine = logs.find((l) => l.includes('kafka(stub)'));
    expect(kafkaLine).toBeDefined();
    expect(kafkaLine).toContain('account=acc-fn-2');
    expect(kafkaLine).toContain('records=2');
  });

  it.skip('多筆訊息批次：每筆都發布 Finalized 事件（consumer 逐筆處理）', async () => {
    const res = await SELF.fetch('https://example.com/events');
    const reader = res.body!.getReader();

    const jobs: FinalizeJob[] = [
      { accountId: 'acc-fn-3', batchId: 'acc-fn-3:1', count: 1 },
      { accountId: 'acc-fn-3', batchId: 'acc-fn-3:2', count: 2 },
    ];
    const batch = createMessageBatch<FinalizeJob>('finalize-queue', [
      { id: 'm1', timestamp: new Date(), body: jobs[0] },
      { id: 'm2', timestamp: new Date(), body: jobs[1] },
    ]);
    const ctx = createExecutionContext();
    await (SELF as unknown as { queue: (b: typeof batch, c: typeof ctx) => Promise<void> }).queue(batch, ctx);
    await getQueueResult(batch, ctx);

    // 兩筆都應送達（依序讀取兩次）
    const chunk1 = await readUntil(reader, 'acc-fn-3:1');
    expect(chunk1).toContain('Finalized');
    const chunk2 = await readUntil(reader, 'acc-fn-3:2');
    expect(chunk2).toContain('Finalized');
    await reader.cancel();
  });
});
