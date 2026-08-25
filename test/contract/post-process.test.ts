// Item 10 契約測試：post-process 全功能——queue consumer 發布 Finalized 事件。
//
// 人類裁決（issue #36 留言）：
//   - Tentative 狀態流**不補實**（維持 stub，與來源一致——來源 L242「審計已於主交易
//     內原子落庫，無懸空狀態」）
//   - 實作範圍：queue consumer 補 (1) Kafka stub log (2) Finalized 領域事件發布到
//     EventHub DO（Item 8 已建）→ SSE 儀表板顯示 Finalized 狀態
//
// 測試方式：
//   - 純邏輯：handleFinalizeJob 注入 fake publish，驗證事件內容（state/accountId/
//     batchId/size）與 Kafka stub log 格式（與來源 post-process 一致）
//   - 端到端：handleFinalizeJob 注入真實 publishEvent → 訂閱 /events SSE 收到
//     Finalized 事件（驗證 EventHub → SSE 完整鏈路）
//   （miniflare 的 queue 投遞不自動觸發 consumer，故以直接呼叫取代該層。）
import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { TxnState, type DomainEvent, type FinalizeJob } from '../../src/shared/types';
import type { Env } from '../../src/platform/env';
import { handleFinalizeJob } from '../../src/platform/post-process';
import { publishEvent } from '../../src/platform/publish-event';

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

describe('post-process 契約（Item 10，H2 人類主導裁決）', () => {
  it('handleFinalizeJob 發布 Finalized 事件（state/accountId/batchId/size 正確）', async () => {
    const job: FinalizeJob = { accountId: 'acc-fn-1', batchId: 'acc-fn-1:123', count: 3 };
    const received: DomainEvent[] = [];
    await handleFinalizeJob(job, async (event) => {
      received.push(event);
    });

    expect(received).toHaveLength(1);
    expect(received[0].state).toBe(TxnState.Finalized);
    expect(received[0].accountId).toBe(job.accountId);
    expect(received[0].batchId).toBe(job.batchId);
    expect(received[0].size).toBe(job.count);
  });

  it('Kafka stub log：輸出 kafka(stub) 格式（與來源 post-process 一致）', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await handleFinalizeJob(
        { accountId: 'acc-fn-2', batchId: 'acc-fn-2:456', count: 2 },
        async () => {},
      );
    } finally {
      console.log = originalLog;
    }
    // 來源格式：kafka(stub) 發布變更事件 account=<id> records=<count>
    const kafkaLine = logs.find((l) => l.includes('kafka(stub)'));
    expect(kafkaLine).toBeDefined();
    expect(kafkaLine).toContain('account=acc-fn-2');
    expect(kafkaLine).toContain('records=2');
  });

  it('端到端：handleFinalizeJob 注入 publishEvent → SSE /events 收到 Finalized 事件', async () => {
    const res = await SELF.fetch('https://example.com/events');
    const reader = res.body!.getReader();

    const job: FinalizeJob = { accountId: 'acc-fn-3', batchId: 'acc-fn-3:789', count: 5 };
    await handleFinalizeJob(job, (event) => publishEvent(e, event));

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

  it('多筆 job 依序處理：每筆都發布 Finalized 事件（consumer 逐筆語意）', async () => {
    const received: Array<{ accountId: string; batchId: string }> = [];
    const jobs: FinalizeJob[] = [
      { accountId: 'acc-fn-4', batchId: 'acc-fn-4:1', count: 1 },
      { accountId: 'acc-fn-4', batchId: 'acc-fn-4:2', count: 2 },
    ];
    for (const job of jobs) {
      await handleFinalizeJob(job, async (event) => {
        received.push({ accountId: event.accountId, batchId: event.batchId ?? '' });
      });
    }
    expect(received).toEqual([
      { accountId: 'acc-fn-4', batchId: 'acc-fn-4:1' },
      { accountId: 'acc-fn-4', batchId: 'acc-fn-4:2' },
    ]);
  });
});
