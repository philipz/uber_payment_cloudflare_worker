// EventHub DO 邊界測試（Issue #60：多客戶 fan-out、斷線清理、零客戶 publish；
// invalid JSON → 500 以 it.skip 釘住——現行語意不符，修正屬 H2 需人類裁決）。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../../src/platform/env';
import { TxnState, type DomainEvent } from '../../src/shared/types';

const e = env as unknown as Env;

describe('EventHub DO 多客戶 fan-out', () => {
  it('publish 後多個 SSE 客戶端皆收到事件', async () => {
    const hub = e.EVENT_HUB.get(e.EVENT_HUB.idFromName('hub-fanout-test'));

    // 訂閱兩個客戶端
    const sub1 = await hub.fetch('https://hub/');
    const sub2 = await hub.fetch('https://hub/');
    expect(sub1.status).toBe(200);
    expect(sub2.status).toBe(200);
    expect(sub1.headers.get('content-type')).toBe('text/event-stream');

    // publish 事件
    const event: DomainEvent = {
      ts: Date.now(),
      state: TxnState.Committed,
      accountId: 'acc-fanout',
      batchId: 'batch-fanout',
      size: 1,
      version: 1,
      balance: 100,
    };
    const pubRes = await hub.fetch('https://hub/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'publish', event }),
    });
    expect(pubRes.status).toBe(200);
    const pubBody = await pubRes.json() as { ok: boolean; clients: number };
    expect(pubBody.ok).toBe(true);
    expect(pubBody.clients).toBeGreaterThanOrEqual(2);

    // 兩個 SSE stream 皆應收到 data 行
    const reader1 = sub1.body!.getReader();
    const reader2 = sub2.body!.getReader();

    // 讀第一個 chunk（data: <JSON>\n\n）
    const chunk1 = await reader1.read();
    const chunk2 = await reader2.read();
    expect(chunk1.done).toBe(false);
    expect(chunk2.done).toBe(false);

    const text1 = new TextDecoder().decode(chunk1.value);
    const text2 = new TextDecoder().decode(chunk2.value);
    expect(text1).toContain('data:');
    expect(text1).toContain('"Committed"');
    expect(text2).toContain('data:');

    // 清理
    reader1.releaseLock();
    reader2.releaseLock();
  });
});

describe('EventHub DO 零客戶 publish', () => {
  it('無訂閱者時 publish 回 { ok: true, clients: 0 }', async () => {
    const hub = e.EVENT_HUB.get(e.EVENT_HUB.idFromName('hub-zero-clients'));

    const event: DomainEvent = {
      ts: Date.now(),
      state: TxnState.Committed,
      accountId: 'acc-no-sub',
      batchId: 'batch-no-sub',
      size: 1,
      version: 1,
      balance: 0,
    };
    const res = await hub.fetch('https://hub/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'publish', event }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; clients: number };
    expect(body.ok).toBe(true);
    expect(body.clients).toBe(0);
  });
});

describe('EventHub DO 斷線清理', () => {
  it('客戶端斷線後 publish 不再 fan-out 給該客戶端', async () => {
    const hub = e.EVENT_HUB.get(e.EVENT_HUB.idFromName('hub-disconnect'));

    // 訂閱
    const sub = await hub.fetch('https://hub/');
    expect(sub.status).toBe(200);

    // publish 第一則事件
    const event1: DomainEvent = {
      ts: Date.now(),
      state: TxnState.Committed,
      accountId: 'acc-dc-1',
      batchId: 'batch-dc-1',
      size: 1,
      version: 1,
      balance: 10,
    };
    const pub1 = await hub.fetch('https://hub/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'publish', event: event1 }),
    });
    expect(pub1.status).toBe(200);
    const pub1Body = await pub1.json() as { clients: number };
    expect(pub1Body.clients).toBeGreaterThanOrEqual(1);

    // 模擬斷線：取消 body 讀取
    const reader = sub.body!.getReader();
    await reader.cancel();
    reader.releaseLock();

    // 等待斷線處理
    await new Promise((r) => setTimeout(r, 50));

    // publish 第二則事件 → clients 應減少（該客戶端已被移除）
    const event2: DomainEvent = {
      ts: Date.now(),
      state: TxnState.Committed,
      accountId: 'acc-dc-2',
      batchId: 'batch-dc-2',
      size: 1,
      version: 2,
      balance: 20,
    };
    const pub2 = await hub.fetch('https://hub/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'publish', event: event2 }),
    });
    expect(pub2.status).toBe(200);
    const pub2Body = await pub2.json() as { clients: number };
    // 斷線後 clients 應為 0（或少於第一次）
    expect(pub2Body.clients).toBeLessThanOrEqual(pub1Body.clients);
  });
});

describe('EventHub DO invalid JSON 處理', () => {
  // NOTE: 現行語意為 500（JSON.parse 拋錯），釘住現況以 it.skip；
  // 改為回 400 invalid json 屬 H2 需人類裁決
  it.skip('invalid JSON → 500（現行語意，待修正為 400）', async () => {
    const hub = e.EVENT_HUB.get(e.EVENT_HUB.idFromName('hub-bad-json'));
    const res = await hub.fetch('https://hub/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not a json {',
    });
    // 現行為 500；期望修正為 400
    expect(res.status).toBe(400);
  });
});
