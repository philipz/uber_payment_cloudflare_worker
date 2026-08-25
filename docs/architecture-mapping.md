# 來源語意 → Cloudflare 平台對映（architecture-mapping）

本文件記錄 `uber_payment_poc`（來源，Node/Redis/Postgres 架構）的語意，對比
本 Worker（`uber_payment_cloudflare_worker`）在 Cloudflare 平台（Durable Object / D1 /
Queues）的落地方案。對應 Factory Item 6（金流核心）。逐項對映為審計/接手可依循的
「來源 → 平台」表。

## 對映總覽

| 來源語意（PoC） | 平台落地（本 Worker） | 關鍵決策 / 依據 |
| --- | --- | --- |
| Redis 對單一 key 的串行化 → Hot Account 單一寫入者 | **Durable Object**（`AccountDO`，以 `accountId` 為 DO id） | 同帳戶所有請求路由到同一實例，天然串行化，無需自建鎖。依 `idFromName(accountId)` 路由（`src/index.ts`）。 |
| 250ms 時間窗口歸集（`keys.ts` `WINDOW_MS = 250`） | DO 內事件驅動 lazy flush + alarm 兜底 | `accumulate` 以 deadline（`windowStart + WINDOW_MS`）決定是否 `flush`；`alarm` 為未到期/commit 失敗的兜底（alarm 最壞延遲 ≤1 分鐘，可接受）。 |
| 批次 buffer（來源記憶體 + Redis） | DO `ctx.storage` 持久化 buffer | hibernation 會丟記憶體，故 buffer / windowStart / accountId 寫入 `ctx.storage`，`ensureLoaded` 時還原。 |
| Redis 全域佇列 `tasks:global`（`GLOBAL_QUEUE`） | 移除——直接由 DO 關窗組成 batch 提交；**不需要**全域任務佇列 | 單一寫入者取代了需排隊的 batch-process；`GLOBAL_QUEUE` 常數保留於 `src/shared/keys.ts` 供語意追溯，未於平台落地。 |
| Postgres 主賬本 + 樂觀鎖版本 | **D1** `accounts`（`balance` / `version`） | OCC 條件 UPDATE（`WHERE version = ?`）+ `version + 1`。 |
| Redis 交易級冪等 / exactly-once | **D1** `processed_transactions` | `ON CONFLICT(transaction_id) DO NOTHING` + `dedupeTransactions` 去重。Exactly-Once = at-least-once 佇列 + 冪等鍵原子去重。 |
| Postgres 審計表 | **D1** `audit`（48-byte MicroUAC BLOB） | 審計與餘額同 `db.batch()` 原子提交；欄位/位元組與來源逐一對應（見下表）。 |
| `MAX_OCC_RETRIES=20` | DO `commitBatch` 迴圈重試 + jitter（`MAX_OCC_RETRIES = 20`） | 單一寫入者使衝突結構性不可能；guard 為防禦性，衝突時 random jitter 後重試。 |
| `migration` 種子帳戶 | `migrations/0001_init.sql`（`hot-account-1`） | 來源「種子後任意帳戶可收單」語意：commitBatch 對不存在帳戶 `INSERT OR IGNORE` 自動建立。 |
| finalize 下游佇列 `finalize:queue`（`FINALIZE_QUEUE`）| **Queues** `finalize-queue`（producer `FINALIZE_QUEUE` + consumer） | at-least-once；`FINALIZE_QUEUE.send({accountId,batchId,count})`，consumer 目前為 stub（僅 log），遺失不影響審計。死信 `finalize-dlq`。 |
| 壓測對照（batched 壓縮比） | **`GET /metrics`**（Item 9，H7 核可）+ **`scripts/load-generator.ts`** runner | Worker 無 naive 模式，naive 以數學基準定義（`naive.dbWrites = naive.requests`，ratio = 1，issue #35 人類裁決）；`/metrics` 對 D1 對帳讀取（`COUNT(processed_transactions)` / `COUNT(DISTINCT applied_version)`）；runner 純邏輯輸出 batched vs naive 對照，展示「250ms 窗口壓縮 DB 寫入」。 |
| Redis pub/sub 事件廣播（`EVENTS_CHANNEL`） | **EventHub DO**（Item 8 已落地） | `src/platform/event-hub-do.ts` 取代 Redis pub/sub 廣播角色：SSE 客戶端 `GET /events` 訂閱 hub，AccountDO commit 成功後 `POST /publish` 發布 `Committed` 事件，hub fan-out `data: <JSON>\n\n`；`/dashboard` 回來源移植的單頁儀表板。`formatSseData` 純函式於 `src/shared/events.ts`（與來源 payload 一致）。 |
| 可靠佇列 worker 心跳/重認領（`WORKERS_SET`、BLMOVE） | **不移植（已取代）** | 來源的 BLMOVE + 心跳重認領語意被 DO 單一寫入者取代，不需工作集心跳；`keys.ts` 的 worker 小工具僅保留追溯，無對應落地。 |

## D1 schema 對映

| D1 表 | 對應來源 | 欄位語意 |
| --- | --- | --- |
| `accounts` | 主賬本 | `id`（PK）、`balance`（最小貨幣單位）、`version`（樂觀鎖） |
| `processed_transactions` | 交易級冪等 | `transaction_id`（PK）、`account_id`、`applied_version`、`balance_after`、`created_at` |
| `audit` | 審計 | `id`（autoincrement）、`account_id`、`micro_uac`（48-byte BLOB）、`status`、`created_at` |

審計 `micro_uac` 的 48-byte 佈局（`src/shared/microuac.ts`）與來源位元組相容：

| offset | 欄位 | 型別 | 說明 |
| --- | --- | --- | --- |
| 0 | TransactionID | Int64 | MD5(transactionId) 前 8 bytes big-endian 收斂 |
| 8 | OperationType | UInt8 | Credit=0x01 / Debit=0x02 / Authorize=0x03 / Release=0x04 |
| 9 | Amount | Int64 | 最小貨幣單位 |
| 17 | SequenceNumber | UInt16 | 批次內順序 |
| 19 | AccountVersion | UInt32 | 提交後賬戶版本 |
| 23 | ReferenceHash | 16 bytes | MD5(referenceId)；無 referenceId 時回退 MD5(transactionId) |
| 39 | BusinessTime | UInt32 | Unix 秒 |
| 43 | ReservedBytes | 5 bytes | 預設全 0 |

MD5 以純 JS 實作（`src/platform/md5.ts`，RFC 1321），因 Workers 無 node:crypto 且要求
保留 MD5 收斂（位元組相容）。

## 路由 → 平台動作

| 路由 | 方法 | 平台動作 |
| --- | --- | --- |
| `/` | GET | 骨架 smoke（回 `OK`） |
| `/health` | GET | 健康檢查 |
| `/accounts/:id/transactions` | POST | 解析交易 → 路由到 `ACCOUNT_DO` → `accumulate`（202 Accepted） |
| `/accounts/:id` | GET | 從 D1 讀餘額/版本/審計/已處理筆數（驗證用） |
| `/events` | GET | SSE 訂閱（Item 8）：路由到 EventHub DO，領域事件即時流 |
| `/dashboard` | GET | 單頁儀表板（Item 8）：EventSource 訂閱 `/events`，即時顯示狀態機流轉 |
| `/metrics` | GET | D1 對帳讀取（Item 9，H7 核可）：回 `{batched, naive}` 計數，壓測對照用 |
| queue consumer `finalize-queue` | — | post-process 全功能（Item 10）：Kafka stub log + Finalized 事件發布到 EventHub → SSE |

## 未實作（規劃中）

- **可靠佇列心跳 / 重認領**（`keys.ts` 的 `WORKERS_SET` / BLMOVE 語意）：**不移植（已取代）**
  ——被 DO 單一寫入者取代，非「待移植」項目；`keys.ts` 小工具僅保留來源追溯。
- **審計 `Tentative` 狀態**：**不補實（人類裁決，issue #36）**——與來源一致（來源
  batch-process L242「審計已於主交易內原子落庫，無懸空狀態」），`audit.status` 僅寫
  `Committed`；補實 Tentative 會偏離來源語意並觸動 `statusCommitted` 不變量。
- **儀表板 `/metrics` 對照區塊**：已於 **Item 9**（load-generator）落地——`GET /metrics`
  （H7 人類核可）對 D1 對帳讀取（不觸 H2/H4）回傳 `{batched, naive}` 計數；
  `scripts/load-generator.ts`（runner 純邏輯）輸出 batched vs naive 壓縮比對照，
  naive 以數學基準定義（`naive.dbWrites = naive.requests`，issue #35 人類裁決）。
  儀表板輪詢 `/metrics` 的對照區塊隨之自動生效。領域事件廣播（`EVENTS_CHANNEL`）
  本身已於 Item 8（EventHub DO + SSE）落地。

## 對照依據

- 來源：`uber_payment_poc`（commit `739d9af`）。語意逐項移植；純邏輯（operations /
  microuac / config / keys / events log）移於 Item 2–4，平台核心（DO/D1/Queues）移於
  Item 6。
- 契約測試：`test/contract/core.test.ts` 驗證窗口歸集、OCC、Exactly-Once 冪等、審計
  48-byte 位元組相容、alarm 兜底、種子帳戶、錯誤路徑。
