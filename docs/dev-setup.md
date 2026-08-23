# 開發環境設定（dev-setup）

本文件說明如何在本機執行與驗證 `uber_payment_cloudflare_worker`（Cloudflare Worker，
TypeScript）。對應 Factory Item 1 之後的狀態：`npm ci && npm test` 綠燈（涵蓋 unit 與
contract/integration 測試）、`npx wrangler dev` 可啟動並支援金流 bindings（D1 / DO /
Queues）。

> 需求：Node.js 22+（CI 亦用 `node-version: 22`）與 npm。

## 1. 安裝相依

```bash
npm ci
```

`npm ci` 依 `package-lock.json` 精準安裝，確保本機與 CI 環境一致。若日後修改了
`package.json`，請改用 `npm install` 以更新 lockfile，再讓 CI 重跑。

> **npm cache permission 錯誤**：若 `npm ci` 因 cache 含 root-owned 檔案而報 EACCES，
> 改用乾淨快取目錄即可：

```bash
npm_config_cache=$(pwd)/.npm-cache npm ci
```

## 2. 執行測試（miniflare）

```bash
npm test
```

- 使用 [Vitest](https://vitest.dev/) + `@cloudflare/vitest-plugin`，在 Miniflare 本地
  Workers runtime 上執行（見 `vitest.config.ts`）。
- 每個 test file 在 isolated storage 上執行——`test/setup.ts` 會先把
  `migrations/0001_init.sql` 套到 D1（`cloudflare:test` 的 `applyD1Migrations`），
  測試彼此互不汙染。
- 測試涵蓋：
  - `test/unit/` — 純邏輯契約：`operations`（餘額重放/去重）、`microuac`（48-byte
    位元組相容）、`config`（缺省回退）、`keys`、`events`（log 格式）、`md5`。
  - `test/contract/core.test.ts` — 金流核心整合契約：250ms 窗口歸集、OCC 版本衝突、
    Exactly-Once 冪等去重、審計 MicroUAC 位元組相容、alarm 兜底 flush、種子帳戶、錯誤路徑。
  - `test/smoke.test.ts` — Worker 能建構並對 `GET /` 回 `200 OK`、未知路徑回 `404`。
- `npm run test:watch` 可進入 watch 模式；CI 用 `npm test`（`vitest run`）。

## 3. 本機啟動 Worker（wrangler dev）

```bash
npm run dev
```

或直接 `npx wrangler dev`。由 `wrangler.toml` 指定入口 `src/index.ts`。啟動後訪問：

```bash
# 健康檢查
curl http://localhost:8787/health
# → {"status":"ok","service":"uber-payment-cloudflare-worker"}

# 骨架 smoke 路徑
curl http://localhost:8787/
# → OK
```

`wrangler dev` 預設在本地 workerd 提供 D1（`--local`）、Durable Object 與
Queues 的全部 bindings，方便本機端到端驗證金流。

### 本機端到端驗證範例（金流）

用 `wrangler dev` 或 Vitest contract 均可。手動收單範例（對 `hot-account-1` 可先不建帳戶，
commitBatch 會 `INSERT OR IGNORE` 自動建立）：

```bash
# 收單（202 Accepted；由 Account DO 250ms 窗口歸集、非同步提交）
curl -X POST http://localhost:8787/accounts/hot-account-1/transactions \
  -H 'content-type: application/json' \
  -d '{"transactionId":"t1","operationType":1,"amount":100}'

# 查詢餘額/版本/審計筆數（驗證用，需等窗口刷新提交）
curl http://localhost:8787/accounts/hot-account-1
```

> 注意：`GET /accounts/:id` 的數值來自 D1 已 commit 的記錄；窗口未到 deadline 前可能
> 仍在 buffer 未落庫，屬預期行為。

## 4. 設定檔與本機變數

- `wrangler.toml`：Worker 設定（名稱 `uber-payment-cloudflare-worker`、入口
  `src/index.ts`）+ bindings：
  - **D1** `DB`（`uber-payment-poc`，`migrations/` 指向真實 DDL）。
  - **Durable Object** `ACCOUNT_DO`（`AccountDO`）。
  - **Queues** `FINALIZE_QUEUE`（producer）與 consumer（`finalize-queue`，含死信
    `finalize-dlq`）。
  - `database_id` 目前為佔位（`00000000-...`）；本機/測試由 Miniflare 用 local mode
    取代，部署前依 `docs/deploy-guide.md` 填入實際 D1 id。
- `.dev.vars.example`：本機開發變數**範例**。複製為 `.dev.vars` 填入你要的本地值
  （`.dev.vars` 已被 gitignore，不會進入 git）。目前僅 placeholder，無機密欄位。
- 正式環境機密一律走 Cloudflare secrets（見 `docs/deploy-guide.md` 的
  `wrangler secret put`），不要在 `package.json`、`wrangler.toml`、`.dev.vars`、或任何
  commit 的檔案中寫入真實機密。

## 5. TypeScript / 型別

- `tsconfig.json` 採用 `@cloudflare/workers-types`，提供 Worker global 型別
  （`Request`、`Response`、`ExportedHandler` 等）。
- 型別檢查（可選）：

  ```bash
  npx tsc --noEmit
  ```

## 6. 部署（人類手動）

```bash
npx wrangler deploy
```

詳見 `docs/deploy-guide.md`（D1 建立、Queues 建立、secret put 步驟）；來源語意對應見
`docs/architecture-mapping.md`。

## 常見問題

- **`npm ci` 報 cache permission 錯誤**：可能 npm 快取含 root-owned 檔案，改用乾淨
  快取目錄即可（`npm_config_cache=$(pwd)/.npm-cache npm ci`）。
- **`wrangler dev` 無法啟動**：確認 Node 22+ 且已執行 `npm ci`；若 `src/index.ts`
  不存在會因找不到入口而啟動失敗。
- **Vitest 對 `finalize-queue`/`finalize-dlq` 報資源未建立**：contract 測試用 Miniflare
  的 local bindings，不需真實佇列；僅 `wrangler deploy` 前需先 `wrangler queues create`
  （見 deploy-guide）。
