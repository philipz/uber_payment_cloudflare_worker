# 開發環境設定（dev-setup）

本文件說明如何在本機執行與驗證 `uber_payment_cloudflare_worker`（Cloudflare Worker，
TypeScript）。對應 Factory Item 1 的驗收條件：`npm ci && npm test` 綠燈（含 smoke test）、
`npx wrangler dev` 可啟動。

> 需求：Node.js 22+（CI 亦用 `node-version: 22`）與 npm。

## 1. 安裝相依

```bash
npm ci
```

`npm ci` 依 `package-lock.json` 精準安裝，確保本機與 CI 環境一致。若日後修改了
`package.json`，請改用 `npm install` 以更新 lockfile，再讓 CI 重跑。

## 2. 執行測試

```bash
npm test
```

- 使用 [Vitest](https://vitest.dev/) + `@cloudflare/vitest-plugin`，在 Miniflare 本地
  Workers runtime 上執行。
- 目前只有骨架 smoke test（`test/smoke.test.ts`）：驗證 Worker 能啟動並對 `GET /`
  回傳 `200 OK`、對未知路徑回傳 `404`。
- 全部綠燈即符合「測試先行」的基礎（後續工作項在此基礎上寫紅→綠測試）。

## 3. 本機啟動 Worker（wrangler dev）

```bash
npm run dev
```

或直接 `npx wrangler dev`。由 `wrangler.toml` 指定入口 `src/index.ts`。啟動後訪問：

```
curl http://localhost:8787/
# → OK
```

`wrangler dev` 可正常啟動代表骨架可執行。

## 4. 設定檔與本機變數

- `wrangler.toml`：Worker 設定（名稱、入口、compatibility_date）。目前僅 placeholder，
  無真實 binding。
- `.dev.vars.example`：本機開發變數**範例**。複製為 `.dev.vars` 填入你要的本地值
  （`.dev.vars` 已被 gitignore，不會進入 git）。
- 正式環境機密一律走 Cloudflare secrets：

  ```bash
  npx wrangler secret put <NAME>
  ```

  不要在 `package.json`、`wrangler.toml`、`.dev.vars`、或任何 commit 的檔案中寫入真實機密。

## 5. TypeScript / 型別

- `tsconfig.json` 採用 `@cloudflare/workers-types`，提供 Worker global 型別
  （`Request`、`Response`、`ExportedHandler` 等）。
- 型別檢查（可選）：

  ```bash
  npx tsc --noEmit
  ```

## 6. 部署（人類手動，後續工作項）

```bash
npx wrangler deploy
```

部署流程與來源語意對映留待 `docs/deploy-guide.md` / `docs/architecture-mapping.md`
（後續工作項）。此處先完成骨架與測試基礎設施。

## 常見問題

- **`npm ci` 報 cache permission 錯誤**：可能是 npm 快取含 root-owned 檔案所致，改用乾淨
  快取目錄即可（`npm_config_cache=$(pwd)/.npm-cache npm ci`）。
- **`wrangler dev` 無法啟動**：確認 Node 22+ 且已執行 `npm ci`；若 `src/index.ts` 不存在
  會因找不到入口而啟動失敗。
