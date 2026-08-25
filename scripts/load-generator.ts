// scripts/load-generator.ts — Item 9 壓測對照 runner（batched vs naive）。
//
// 移植自 uber_payment_poc 的 load-generator/index.ts + runner.ts（來源 95 行）。
// 純邏輯（naive 數學基準、ratio 計算、對照輸出組裝）為測試主體，可獨立單元測試；
// `runBenchmark` 為對部署環境灌負載的非同步 runner（人工壓測用，CI 只測純邏輯）。
//
// naive 基準線定義（人類裁決，issue #35 留言）——Worker 沒有 naive 模式（僅 batched
// 250ms 窗口歸集），naive 以「理想值」數學基準定義，**不新增任何金流邏輯**：
//   naive.requests = 成功提交筆數（與 batched 相同負載）
//   naive.dbWrites = naive.requests（每筆一次 DB 寫入的理想值）
//   naive.ratio    = requests / dbWrites = 1
// 目的：與 batched 的 `ratio ≥ 1` 對照，展示「250ms 窗口把 N 筆 DB 寫入壓縮為 1 筆」。

export interface Counts {
  requests: number;
  dbWrites: number;
}

export interface MetricsSnapshot {
  batched: Counts;
  naive: Counts;
}

export interface ScenarioResult {
  requests: number;
  dbWrites: number;
  ratio: number; // requests / dbWrites（dbWrites > 0，否則為 0 避免除零）
  throughput: number; // requests / 秒（elapsedMs 為 0 時為 0）
  avgLatencyMs: number; // 本趟基準量測的窗口時間（ms）
}

// 可注入的 fetch 型別（測試便利之窄化版：workerd/Node 的 fetch 皆可指派）。
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// naive 數學基準：每筆一次理想 DB 寫入（ratio = requests / dbWrites = 1）。
export function naiveBaseline(requests: number): Counts {
  return { requests, dbWrites: requests };
}

// batched 壓縮比：requests / dbWrites。dbWrites 為 0 時回傳 0（避免除零），
// 由快照判定「尚無資料」而非錯誤。
export function computeRatio(requests: number, dbWrites: number): number {
  return dbWrites > 0 ? requests / dbWrites : 0;
}

// 由計數 + 本趟量測時間（ms）建構 ScenarioResult。用於 batched；naive 以
// naiveBaseline 產生的計數代入即可得出理想 ratio = 1。
export function scenarioFromCounts(counts: Counts, elapsedMs: number): ScenarioResult {
  const ratio = computeRatio(counts.requests, counts.dbWrites);
  const throughput = elapsedMs > 0 ? (counts.requests * 1000) / elapsedMs : 0;
  return { requests: counts.requests, dbWrites: counts.dbWrites, ratio, throughput, avgLatencyMs: elapsedMs };
}

// 組裝與 /metrics 快照一致的對照輸出（batched vs naive）——「runner 對照輸出格式
// 與來源一致」的純函式核心。每欄位含 requests/dbWrites/ratio（快照為計數級，
// 無時間量測，throughput/avgLatencyMs 為 0）。
export function buildComparison(snapshot: MetricsSnapshot): {
  batched: ScenarioResult;
  naive: ScenarioResult;
} {
  return {
    batched: scenarioFromCounts(snapshot.batched, 0),
    naive: scenarioFromCounts(snapshot.naive, 0),
  };
}

// 讀取部署環境的 /metrics（與來源 runner 的 readMetrics(baseUrl) 一致）。
// fetchImpl 可注入以便單元測試（不依賴真實網路／workerd）。
export async function readMetrics(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<MetricsSnapshot> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/metrics`);
  if (!res.ok) throw new Error(`/metrics HTTP ${res.status}`);
  return (await res.json()) as MetricsSnapshot;
}

// 對熱點帳戶灌一輪負載（與來源 runner 對外行為一致），並輸出 batched vs naive 對照。
// 純邏輯計算在 buildComparison；此函式只做「送單 → 讀 /metrics → 比較」編排。
// `concurrency`：同時在途的請求數（預設 1 = 順序）；來源 runner 的 concurrency 語意。
// `durationMs`：灌壓持續時間（預設不限）；超過即停止送單（來源 runner 語意）。
export interface BenchmarkOptions {
  baseUrl: string;
  accountId: string;
  transactions: Array<{ transactionId: string; amount: number }>;
  /** 同時在途請求數（預設 1 = 順序送單）。 */
  concurrency?: number;
  /** 灌壓持續時間上限（ms）；預設不限。 */
  durationMs?: number;
  fetchImpl?: FetchLike;
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<{
  comparison: ReturnType<typeof buildComparison>;
  metrics: MetricsSnapshot;
}> {
  const f = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const deadline = opts.durationMs !== undefined ? Date.now() + opts.durationMs : undefined;
  let sent = 0;
  const post = async (t: { transactionId: string; amount: number }): Promise<void> => {
    const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/accounts/${opts.accountId}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId: t.transactionId, operationType: 1, amount: t.amount }),
    });
    if (!res.ok) throw new Error(`POST transactions HTTP ${res.status}`);
    await res.json();
  };

  // 工作佇列：以 concurrency 個 worker 依序取交易送單（來源 runner 的 Promise.all 語意）
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < opts.transactions.length) {
      if (deadline !== undefined && Date.now() > deadline) break;
      const t = opts.transactions[next++];
      await post(t);
      sent++;
    }
  });
  await Promise.all(workers);

  const metrics = await readMetrics(opts.baseUrl, f);
  return { comparison: buildComparison(metrics), metrics };
}
