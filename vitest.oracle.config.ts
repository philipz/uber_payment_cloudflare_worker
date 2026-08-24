// Oracle harness 專用 vitest config：純 Node 環境（不用 cloudflare 插件）。
// 原因：oracle 用 execFileSync 跑 quint run（node:child_process）——workerd 內不可用，
// 故與 workerd 測試分離（quint-verify.yml 的 Oracle harness 步驟用 npm run test:oracle）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/quint/**/*.test.ts'],
    globals: true,
    testTimeout: 120000,
  },
});
