# 部署手冊（deploy-guide）

> 部署由**人類手動**執行，不屬 factory 自動化範圍（見 `docs/factory-work-items-cloudflare-port.md`
> 執行順序第 5 步）。本文件是 Cloudflare Worker 首次部署到正式環境的逐步指引。

部署週期：**本機驗證 → 建立資源（D1 / Queues）→ 設定 secret → `wrangler deploy` → 部署後驗證**。

## 0. 前置

- 已依 `docs/dev-setup.md` 在本機跑綠 `npm test`，且 `npx wrangler dev`
  可啟動並端到端驗證金流。
- 已安裝並登入 Wrangler：

  ```bash
  npx wrangler login
  ```

- 確認你對目標 Cloudflare Account 擁有「Worker 編輯」權限，且該 Account 已啟用
  Durable Objects、Workers Queues（皆為實驗性/付費功能時會由 wrangler 提示啟用）。

## 1. 建立資源

### 1.1 D1 資料庫

`wrangler.toml` 中 `database_id` 目前為佔位，部署前需建立並填入真實 id：

```bash
# 建立 D1 資料庫（名稱與 wrangler.toml 的 database_name 一致）
npx wrangler d1 create uber-payment-poc
```

輸出會給 `database_id`——把該值填入 `wrangler.toml` 的 `[[d1_databases]]`（`database_id`
欄位），取代 `00000000-0000-0000-0000-000000000000`。

套用 migration（`migrations/0001_init.sql`：accounts / processed_transactions / audit 三表
+ 種子帳戶）：

```bash
npx wrangler d1 migrations apply uber-payment-poc --remote
```

> 本機/測試由 Miniflare local mode 處理 migrations（見 `test/setup.ts`）。

### 1.2 Queues

`wrangler.toml` 宣告了 producer `FINALIZE_QUEUE`（`finalize-queue`）與 consumer
（含死信佇列 `finalize-dlq`）。首次部署前建立佇列：

```bash
# 主佇列
npx wrangler queues create finalize-queue

# 死信佇列（consumer 設定 dead_letter_queue 指向它）
npx wrangler queues create finalize-dlq
```

> 佈署時 consumer 的 `max_batch_size` / `max_retries` / `dead_letter_queue` 已寫在
> `wrangler.toml`，只要兩個佇列名稱存在即可。

## 2. 設定環境變數與機密（secret）

正式環境機密一律走 Cloudflare secrets，**不 commit、不進 `.dev.vars`**：

```bash
npx wrangler secret put <NAME>
```

互動輸入值。目前 `.dev.vars.example` 無真實機密欄位（僅 placeholder）；若程式日後
新增任何機密（如 API key），一律以 `wrangler secret put` 設定，並保持在 `wrangler.toml`
/ `.dev.vars` / 任何 git 檔案中不寫入真實值。

## 3. 部署 Worker

```bash
npx wrangler deploy
```

Wrangler 會依 `wrangler.toml`（name、main、compatibility_date、bindings）建構並上傳。
首次部署會自動建立該 Worker 的 Durable Object migrations（`migrations` 區塊的
`new_sqlite_classes: ["AccountDO"]`）。

部署成功會輸出 `https://<worker-name>.<subdomain>.workers.dev` 的 URL。

> 若首次部署在啟用 DO / Queues 時要求新的 terms / feature，依 wrangler 提示在 Cloudflare
> dashboards 啟用後重跑。

## 4. 部署後驗證

```bash
# 健康檢查
curl https://<worker-name>.<subdomain>.workers.dev/health

# 收單（202 Accepted）
curl -X POST https://<worker-name>.<subdomain>.workers.dev/accounts/hot-account-1/transactions \
  -H 'content-type: application/json' \
  -d '{"transactionId":"t-remote-1","operationType":1,"amount":100}'

# 查詢餘額/版本/審計筆數
curl https://<worker-name>.<subdomain>.workers.dev/accounts/hot-account-1
```

> 非同步提交：`POST /transactions` 立即回 `202`；`GET /accounts/:id` 讀的是已 commit
> 到 D1 的記錄，需等 250ms 窗口刷新（或下游佇列處理）後數值才更新。

可用 Cloudflare dashboards（Workers → D1 → console）確認 `accounts` / `audit` /
`processed_transactions` 三表已有資料。

## 5. 更新與回滾

- **更新**：改程式與 `wrangler.toml` 後重新 `npx wrangler deploy`。新增 migration 時
  `npx wrangler d1 migrations apply uber-payment-poc --remote`。
- **回滾**：`npx wrangler deployments list` 找前一版，`npx wrangler rollback` 回到該版。

## 風險與注意

- 本 Worker 為第 1 期金流核心；**任何餘額運算 / 授權 / 敏感資料處理的變更，不應由
  自動化 agent 進行**（factory-stop-rules SR2），須人類主導。
- 正式環境佇列、D1 若需刪除重建會遺失資料且破壞 Exactly-Once 語意，操作前再三確認。
- `wrangler.toml` 的 `database_id` 一旦填入真實值即屬環境特定資訊——確認不在 `git`
  中意外 commit 機密或佔位 id 誤導後續部署。
