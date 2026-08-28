// Item 9 load-generator 純邏輯單元測試（naive 數學基準 / batched 壓縮比 / 對照輸出）。
//
// 對照「batched vs naive」的 ratio 語意：
//   - naive：數學基準，naive.dbWrites = naive.requests → ratio = 1（人類裁決，issue #35）
//   - batched：250ms 窗口把 N 筆 DB 寫入壓縮為 1 筆 → 實務上 dbWrites < requests，
//     ratio ≥ 1。本測試斷言 batched ratio ≥ naive ratio（= 1），展示壓縮效果。
//
// readMetrics/runBenchmark 的網路層以注入 fetchImpl 驗證（不依賴真實網路／workerd），
// 序列化格式與 /metrics 契約一致（見 test/contract/metrics.test.ts）。
// Issue #60：擴充 durationMs 截止、空交易邊界。
import { describe, expect, it } from 'vitest';
import {
  buildComparison,
  computeRatio,
  naiveBaseline,
  readMetrics,
  runBenchmark,
  scenarioFromCounts,
  type MetricsSnapshot,
} from '../../scripts/load-generator';

describe('naiveBaseline（數學基準，issue #35 人類裁決）', () => {
  it('naive.dbWrites = naive.requests（每筆一次理想 DB 寫入）', () => {
    expect(naiveBaseline(0)).toEqual({ requests: 0, dbWrites: 0 });
    expect(naiveBaseline(5)).toEqual({ requests: 5, dbWrites: 5 });
  });
});

describe('computeRatio（batched 壓縮比）', () => {
  it('ratio = requests / dbWrites', () => {
    expect(computeRatio(10, 5)).toBe(2);
    expect(computeRatio(10, 10)).toBe(1);
  });

  it('dbWrites = 0 時回傳 0（避免除零，代表尚無資料而非錯誤）', () => {
    expect(computeRatio(0, 0)).toBe(0);
    expect(computeRatio(50, 0)).toBe(0);
  });
});

describe('scenarioFromCounts', () => {
  it('由計數 + 量測時間組裝 ScenarioResult（ratio/throughput/avgLatencyMs）', () => {
    const r = scenarioFromCounts({ requests: 100, dbWrites: 10 }, 2000);
    expect(r.requests).toBe(100);
    expect(r.dbWrites).toBe(10);
    expect(r.ratio).toBeCloseTo(10);
    expect(r.throughput).toBeCloseTo(50); // 100 / 2秒 = 50 req/s
    expect(r.avgLatencyMs).toBe(2000);
  });

  it('elapsedMs = 0 時 throughput 為 0', () => {
    const r = scenarioFromCounts({ requests: 30, dbWrites: 3 }, 0);
    expect(r.throughput).toBe(0);
  });
});

describe('buildComparison（runner 對照輸出，格式與 /metrics 快照一致）', () => {
  const snapshot: MetricsSnapshot = {
    batched: { requests: 100, dbWrites: 5 },
    naive: { requests: 100, dbWrites: 100 },
  };

  it('naive ratio = 1（理想基準線）', () => {
    const c = buildComparison(snapshot);
    expect(c.naive.ratio).toBe(1);
    expect(c.naive.requests).toBe(100);
    expect(c.naive.dbWrites).toBe(100);
  });

  it('batched ratio ≥ 1 且 ≥ naive ratio（250ms 窗口壓縮 DB 寫入）', () => {
    const c = buildComparison(snapshot);
    expect(c.batched.requests).toBe(100);
    expect(c.batched.dbWrites).toBe(5);
    expect(c.batched.ratio).toBeGreaterThanOrEqual(1);
    expect(c.batched.ratio).toBeGreaterThanOrEqual(c.naive.ratio);
  });

  it('batched 對照輸出必滿足 ratio ≥ 1 的合理斷言（DoD）', () => {
    // 壓縮效果：dbWrites < requests 時 ratio > 1；退化至無壓縮時 ratio = 1
    const comp = buildComparison({ batched: { requests: 7, dbWrites: 1 }, naive: { requests: 7, dbWrites: 7 } });
    expect(comp.batched.ratio).toBeGreaterThanOrEqual(1);
  });
});

describe('readMetrics（注入 fetch 驗證 /metrics 讀取與錯誤處理）', () => {
  it('解析 /metrics 回應為 MetricsSnapshot（前導/尾隨斜線皆可）', async () => {
    const snap: MetricsSnapshot = { batched: { requests: 3, dbWrites: 1 }, naive: { requests: 3, dbWrites: 3 } };
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await readMetrics('https://edge.example', fakeFetch);
    await readMetrics('https://edge.example/', fakeFetch);
    expect(calls).toEqual(['https://edge.example/metrics', 'https://edge.example/metrics']);
  });

  it('非 2xx 回應擲錯（HTTP 狀態）', async () => {
    const fakeFetch = async () => new Response('boom', { status: 500 });
    await expect(readMetrics('https://edge.example', fakeFetch)).rejects.toThrow('HTTP 500');
  });
});

describe('runBenchmark（POST 單 → 讀 /metrics → 對照輸出）', () => {
  it('依序送單後回傳對照與 /metrics 快照', async () => {
    const snap: MetricsSnapshot = { batched: { requests: 2, dbWrites: 1 }, naive: { requests: 2, dbWrites: 2 } };
    const posted: Array<{ url: string; body: string }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      if (String(url).includes('/transactions')) {
        posted.push({ url: String(url), body: String(init?.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res = await runBenchmark({
      baseUrl: 'https://edge.example',
      accountId: 'hot-account-1',
      transactions: [
        { transactionId: 'lg-1', amount: 100 },
        { transactionId: 'lg-2', amount: 30 },
      ],
      fetchImpl: fakeFetch,
    });
    expect(posted).toHaveLength(2);
    expect(posted[0].url).toBe('https://edge.example/accounts/hot-account-1/transactions');
    expect(posted[0].body).toContain('"transactionId":"lg-1"');
    expect(posted[1].body).toContain('"transactionId":"lg-2"');
    expect(res.metrics).toEqual(snap);
    expect(res.comparison.naive.ratio).toBe(1);
  });

  it('POST 收到非 2xx 時擲錯', async () => {
    const fakeFetch = async () => new Response('overloaded', { status: 429 });
    await expect(
      runBenchmark({
        baseUrl: 'https://edge.example',
        accountId: 'hot-account-1',
        transactions: [{ transactionId: 'lg-x', amount: 1 }],
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow('HTTP 429');
  });
});

describe('runBenchmark 邊界條件（Issue #60）', () => {
  const metricsJson: MetricsSnapshot = {
    batched: { requests: 0, dbWrites: 0 },
    naive: { requests: 0, dbWrites: 0 },
  };

  it('durationMs 截止後停止送單', async () => {
    let posted = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.method).toUpperCase() === 'POST') {
        // 模擬每筆 POST 耗時 50ms
        await new Promise((r) => setTimeout(r, 50));
        posted++;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify(metricsJson), { status: 200 });
    };

    // 10 筆交易，每筆 50ms，總共需 500ms
    // durationMs = 150ms → 預期約 3 筆（視 timing 有誤差）
    const res = await runBenchmark({
      baseUrl: 'https://test.dev',
      accountId: 'acc-dur',
      transactions: Array.from({ length: 10 }, (_, i) => ({ transactionId: `dur-${i}`, amount: 1 })),
      durationMs: 150,
      fetchImpl: fakeFetch,
    });

    // 由於 timing 不確定，只斷言 posted < 10（截止有效）
    expect(posted).toBeLessThan(10);
    expect(res.metrics).toEqual(metricsJson);
  });

  it('空交易列表 → 直接讀 /metrics 回傳', async () => {
    let posted = 0;
    const snap: MetricsSnapshot = { batched: { requests: 5, dbWrites: 2 }, naive: { requests: 5, dbWrites: 5 } };
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.method).toUpperCase() === 'POST') {
        posted++;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify(snap), { status: 200 });
    };

    const res = await runBenchmark({
      baseUrl: 'https://test.dev',
      accountId: 'acc-empty',
      transactions: [],
      fetchImpl: fakeFetch,
    });

    expect(posted).toBe(0);
    expect(res.metrics).toEqual(snap);
    expect(res.comparison.batched.requests).toBe(5);
  });
});
