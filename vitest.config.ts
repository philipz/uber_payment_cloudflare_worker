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
    // Oracle harness 在純 Node 跑（execFileSync 需 node:child_process）——
    // 用 vitest.oracle.config.ts + npm run test:oracle，排除在 workerd pool 之外
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "test/quint/**"],
  },
});
