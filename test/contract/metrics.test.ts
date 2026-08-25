// Item 9 `/metrics` 契約測試（H7 人類核可，issue #35 留言）。
//
// `/metrics` 對壓測對照提供 D1 對帳計數（不觸 H2 金流計算、不觸 H4 db 層）：
//   batched.requests = COUNT(processed_transactions)
//   batched.dbWrites = COUNT(DISTINCT applied_version)（每批次 version+1 = 一次 D1 寫入）
//   naive.*          = 數學基準（naive.dbWrites = naive.requests → ratio = 1）
// 回應格式與來源 runner.ts 的 Metrics 介面一致：
//   { batched: { requests, dbWrites }, naive: { requests, dbWrites } }
//
// 此測試層（01-test）先以 it.skip 提交（斷言完整保留、該層獨立綠燈）；02-impl 層
// un-skip 並在 src/index.ts 新增 GET /metrics 端點後轉綠。
import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { OperationType, type TransactionInput } from '../../src/shared/types';

const T = (transactionId: string, amount: number): TransactionInput => ({
  transactionId,
  operationType: OperationType.Credit,
  amount,
});

describe('GET /metrics 契約（Item 9，H7 人類核可）', () => {
  it.skip('回 Metrics 對照：{ batched, naive } 各含 requests/dbWrites，初始為 0', async () => {
    const res = await SELF.fetch('https://example.com/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      batched: { requests: number; dbWrites: number };
      naive: { requests: number; dbWrites: number };
    };
    expect(typeof body.batched.requests).toBe('number');
    expect(typeof body.batched.dbWrites).toBe('number');
    expect(typeof body.naive.requests).toBe('number');
    expect(typeof body.naive.dbWrites).toBe('number');
    // 初始快照：無交易 → 計數 0；naive.dbWrites = naive.requests（數學基準）
    expect(body.batched.requests).toBe(0);
    expect(body.batched.dbWrites).toBe(0);
    expect(body.naive.requests).toBe(0);
    expect(body.naive.dbWrites).toBe(0);
  });

  it.skip('交易提交後：batched.dbWrites ≤ batched.requests 且 naive 為數學基準（ratio=1）', async () => {
    const acc = 'acc-metrics-1';
    // 同一窗口歸集為一批次 → applied_version 相同 → COUNT(DISTINCT version) = 1
    for (const t of [['m1', 100], ['m2', 30], ['m3', 5]] as Array<[string, number]>) {
      const post = await SELF.fetch(`https://example.com/accounts/${acc}/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(T(t[0], t[1])),
      });
      expect(post.status).toBe(202);
    }
    // 等待最終一致（比照 core.test.ts 先例：輪詢帳戶直到全部入帳再讀 /metrics）
    let processed = 0;
    for (let i = 0; i < 50; i++) {
      const accRes = await SELF.fetch(`https://example.com/accounts/${acc}`);
      const accJson = (await accRes.json()) as { processedCount: number };
      processed = accJson.processedCount ?? 0;
      if (processed >= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(processed).toBe(3);

    const res = await SELF.fetch('https://example.com/metrics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      batched: { requests: number; dbWrites: number };
      naive: { requests: number; dbWrites: number };
    };
    // batched：requests = 提交筆數，dbWrites = ≤ requests（窗口壓縮）
    expect(body.batched.requests).toBe(3);
    expect(body.batched.dbWrites).toBeLessThanOrEqual(3);
    expect(body.batched.dbWrites).toBeGreaterThanOrEqual(1);
    // naive：數學基準，dbWrites = requests（ratio = 1），與 batched 同負載
    expect(body.naive.requests).toBe(body.batched.requests);
    expect(body.naive.dbWrites).toBe(body.naive.requests);
  });
});
