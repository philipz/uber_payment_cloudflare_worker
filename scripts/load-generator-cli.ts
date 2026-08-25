#!/usr/bin/env node
// scripts/load-generator-cli.ts — Item 9 壓測對照 CLI（P5 runbook 可執行入口）。
//
// 用法（Node 22.6+，--experimental-strip-types 直接跑 TS，無需 tsx/編譯）：
//   node --experimental-strip-types scripts/load-generator-cli.ts \
//     --base-url https://<worker>.workers.dev --account hot-account-1 \
//     --count 100 [--concurrency 20] [--duration-ms 3000] [--amount 1]
//
// 對部署的 Worker 灌 N 筆交易，讀 /metrics 輸出 batched vs naive 對照
// （batched 壓縮比 ≥ 1 展示 250ms 窗口壓縮；naive = 數學基準 ratio=1）。
// 參數解析與 transactions 產生為純函式（可單元測試）；main() 為副作用入口。
import { runBenchmark } from './load-generator.ts';

export interface CliOptions {
  baseUrl: string;
  accountId: string;
  count: number;
  concurrency: number;
  durationMs?: number;
  amount: number;
}

/** 解析 CLI 參數（--key value 或 --key=value；未知參數拋錯）。純函式，可測試。 */
export function parseArgs(argv: string[]): CliOptions {
  const get = (key: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${key}` && i + 1 < argv.length) return argv[i + 1];
      const eq = argv[i].startsWith(`--${key}=`);
      if (eq) return argv[i].slice(`--${key}=`.length);
    }
    return undefined;
  };
  const num = (key: string, fallback: number): number => {
    const v = get(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${key} 必須為非負數，got "${v}"`);
    return n;
  };

  const baseUrl = get('base-url');
  const accountId = get('account');
  if (!baseUrl) throw new Error('缺少 --base-url <url>（部署的 Worker URL）');
  if (!accountId) throw new Error('缺少 --account <id>（灌壓目標帳戶）');

  return {
    baseUrl,
    accountId,
    count: num('count', 20),
    concurrency: num('concurrency', 1),
    durationMs: get('duration-ms') !== undefined ? num('duration-ms', 0) : undefined,
    amount: num('amount', 1),
  };
}

/** 產生 transactions（transactionId 唯一）。純函式，可測試。 */
export function buildTransactions(count: number, amount: number): Array<{ transactionId: string; amount: number }> {
  return Array.from({ length: count }, (_, i) => ({ transactionId: `lg-${Date.now()}-${i}`, amount }));
}

/** CLI 主流程（副作用入口：灌壓 → 讀 /metrics → 印對照）。 */
export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  const { comparison, metrics } = await runBenchmark({
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    transactions: buildTransactions(opts.count, opts.amount),
    concurrency: opts.concurrency,
    durationMs: opts.durationMs,
  });
  console.log(JSON.stringify({ options: opts, metrics, comparison }, null, 2));
}

// 直接執行時（node scripts/load-generator-cli.ts）才跑 main；被 import 時不執行
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('load-generator-cli.ts') || process.argv[1].endsWith('load-generator-cli.js'));
if (isDirectRun) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`load-generator: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
