import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      // cloudflare:test 的 env/DO 工具鏈在 workerd 內需要 node:* 模組——僅測試環境啟用
      miniflare: { compatibilityFlags: ["nodejs_compat"] },
    }),
  ],
  test: {
    globals: true,
    // 每個 test file（isolated storage）先套用 D1 migrations
    setupFiles: ["./test/setup.ts"],
    // 關閉 file 級並行：workerd 的 DO/D1 契約測試並行執行會互相爭用而偶發逾時
    // （core/contract 的 eventual-consistency 輪詢在並行下不及提交）。序列化執行使
    // 斷言確定可重現，未更動任何斷言。結果快照/計數型測試不受影響。
    fileParallelism: false,
    // 契約測試含最終一致輪詢（DO/D1 非同步提交），放寬單測逾時（預設 5000ms 在慢 CI 下不足）。
    testTimeout: 30000,
    // Oracle harness 在純 Node 跑（execFileSync 需 node:child_process）——
    // 用 vitest.oracle.config.ts + npm run test:oracle，排除在 workerd pool 之外
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "test/quint/**"],
  },
});
