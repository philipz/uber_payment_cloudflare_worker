// Item 9 CLI（scripts/load-generator-cli.ts）純函式單元測試。
// 覆蓋：parseArgs 參數解析（--key value / --key=value / 缺參數 / 非法數值）、
// buildTransactions（數量與唯一性）、runBenchmark 並發語意（fake fetch 計數）。
// Issue #60：擴充 --duration-ms 邊界、未知 flag。
import { describe, expect, it } from 'vitest';
import { buildTransactions, parseArgs } from '../../scripts/load-generator-cli';
import { runBenchmark, type MetricsSnapshot } from '../../scripts/load-generator';

describe('parseArgs（CLI 參數解析）', () => {
  it('--key value 與 --key=value 皆支援', () => {
    const a = parseArgs(['--base-url', 'https://x.dev', '--account', 'acc-1', '--count', '50']);
    expect(a).toEqual({ baseUrl: 'https://x.dev', accountId: 'acc-1', count: 50, concurrency: 1, amount: 1, durationMs: undefined });
    const b = parseArgs(['--base-url=https://y.dev', '--account=acc-2', '--count=10', '--concurrency=5', '--amount=2']);
    expect(b).toEqual({ baseUrl: 'https://y.dev', accountId: 'acc-2', count: 10, concurrency: 5, amount: 2, durationMs: undefined });
  });

  it('缺 --base-url 或 --account → 拋錯', () => {
    expect(() => parseArgs(['--base-url', 'https://x.dev'])).toThrow('--account');
    expect(() => parseArgs(['--account', 'acc-1'])).toThrow('--base-url');
  });

  it('非法數值 → 拋錯', () => {
    expect(() => parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--count', 'abc'])).toThrow('--count');
    expect(() => parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--count', '-5'])).toThrow('--count');
  });
});

describe('parseArgs --duration-ms 邊界（Issue #60）', () => {
  it('--duration-ms 有效正數', () => {
    const a = parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--duration-ms', '3000']);
    expect(a.durationMs).toBe(3000);
  });

  it('--duration-ms=0 視為有效（立即截止）', () => {
    const a = parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--duration-ms=0']);
    expect(a.durationMs).toBe(0);
  });

  it('--duration-ms 負數 → 拋錯', () => {
    expect(() => parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--duration-ms', '-100'])).toThrow('--duration-ms');
  });

  it('--duration-ms 非數值 → 拋錯', () => {
    expect(() => parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--duration-ms', 'abc'])).toThrow('--duration-ms');
  });
});

describe('parseArgs 未知 flag（Issue #60 釘住現行語意）', () => {
  // 現行語意：未知 flag 被忽略（不拋錯）——純寬鬆解析
  it('未知 flag 被忽略（不影響必填參數）', () => {
    const a = parseArgs(['--base-url', 'https://x.dev', '--account', 'a', '--unknown-flag', 'value', '--weird=123']);
    expect(a.baseUrl).toBe('https://x.dev');
    expect(a.accountId).toBe('a');
  });
});

describe('buildTransactions', () => {
  it('產生指定數量且 transactionId 唯一', () => {
    const txs = buildTransactions(10, 3);
    expect(txs).toHaveLength(10);
    expect(txs.every((t) => t.amount === 3)).toBe(true);
    expect(new Set(txs.map((t) => t.transactionId)).size).toBe(10);
  });
});

describe('buildTransactions 邊界（Issue #60）', () => {
  it('count = 0 → 空陣列', () => {
    const txs = buildTransactions(0, 1);
    expect(txs).toEqual([]);
  });

  it('amount = 0 → 所有交易 amount = 0', () => {
    const txs = buildTransactions(3, 0);
    expect(txs).toHaveLength(3);
    expect(txs.every((t) => t.amount === 0)).toBe(true);
  });
});

describe('runBenchmark 並發語意（fake fetch）', () => {
  const metricsJson: MetricsSnapshot = {
    batched: { requests: 0, dbWrites: 0 },
    naive: { requests: 0, dbWrites: 0 },
  };

  it('concurrency > 1 時所有交易都送達（fake fetch 計數 = count）', async () => {
    let posted = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.method).toUpperCase() === 'POST') {
        posted++;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify(metricsJson), { status: 200 });
    };
    const r = await runBenchmark({
      baseUrl: 'https://test.dev',
      accountId: 'acc-c',
      transactions: Array.from({ length: 30 }, (_, i) => ({ transactionId: `t${i}`, amount: 1 })),
      concurrency: 10,
      fetchImpl: fakeFetch,
    });
    expect(posted).toBe(30);
    expect(r.metrics).toEqual(metricsJson);
    expect(r.comparison.batched.requests).toBe(0);
  });

  it('concurrency 預設 1 = 順序送單（仍全數送達）', async () => {
    let posted = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (String(init?.method).toUpperCase() === 'POST') {
        posted++;
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      return new Response(JSON.stringify(metricsJson), { status: 200 });
    };
    await runBenchmark({
      baseUrl: 'https://test.dev',
      accountId: 'acc-s',
      transactions: Array.from({ length: 5 }, (_, i) => ({ transactionId: `t${i}`, amount: 1 })),
      fetchImpl: fakeFetch,
    });
    expect(posted).toBe(5);
  });
});
