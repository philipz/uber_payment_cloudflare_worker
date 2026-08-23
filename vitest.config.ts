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
  },
});
