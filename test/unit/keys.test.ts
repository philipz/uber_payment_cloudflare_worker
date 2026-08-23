import { describe, expect, it } from 'vitest';
import {
  EVENTS_CHANNEL,
  FINALIZE_QUEUE,
  GLOBAL_QUEUE,
  WINDOW_MS,
  WORKERS_SET,
  aliveKey,
  dbWritesKey,
  processingKey,
  requestsKey,
  resultKey,
} from '../../src/shared/keys';

// 移植自 uber_payment_poc（commit 739d9af）——key 命名契約與來源一致，作為語意契約。

describe('keys (命名常數與 key 小工具)', () => {
  it('全域佇列常數與來源一致', () => {
    expect(GLOBAL_QUEUE).toBe('tasks:global');
  });

  it('時間窗口長度為 250ms', () => {
    expect(WINDOW_MS).toBe(250);
  });

  it('finalize 通知佇列與事件頻道常數', () => {
    expect(FINALIZE_QUEUE).toBe('finalize:queue');
    expect(EVENTS_CHANNEL).toBe('events');
  });

  it('worker 可靠佇列集合常數', () => {
    expect(WORKERS_SET).toBe('workers');
  });

  it('對照組計量 key 依模式命名', () => {
    expect(requestsKey('batched')).toBe('metrics:requests:batched');
    expect(requestsKey('naive')).toBe('metrics:requests:naive');
    expect(dbWritesKey('batched')).toBe('metrics:dbwrites:batched');
  });

  it('可靠佇列 processing 與存活 key 依 workerId 命名', () => {
    expect(processingKey('w1')).toBe('processing:w1');
    expect(aliveKey('w1')).toBe('worker:alive:w1');
  });

  it('結果快取 key 依 taskId 命名', () => {
    expect(resultKey('t1')).toBe('result:t1');
  });
});
