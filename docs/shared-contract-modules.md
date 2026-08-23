# 共享契約模組：config / keys / events（Factory Item 4）

本文件說明 `src/shared/` 下三個平台無關契約模組（移植自 `uber_payment_poc`，
commit `739d9af`），供後續 Worker 路由與金流核心（DO/D1/Queues）引用。

## `src/shared/config.ts` — 環境設定解析

依 Cloudflare Worker 環境調整（原 PoC 為 node:http 服務）：

- 以 **env bindings 物件** 取代 global `process.env` —— `loadConfig(env)` 接收
  Worker handler 的 env（或其子集），保持平台無關、可注入測試。
- 移除節點專屬欄位（`port` / `redisUrl` / `databaseUrl`）：Worker 由 fetch 入口服務，
  外部儲存走平台 binding（D1/KV/Queues，屬 Item 6 範圍），此層**不引入** binding 讀取邏輯。

欄位與缺省回退語意：

| 欄位 | 來源 env 鍵 | 預設 |
| --- | --- | --- |
| `serviceName` | `SERVICE_NAME` | `unknown` |
| `azId` | `AZ_ID` | `az-local` |
| `logLevel` | `LOG_LEVEL`（對應 `.dev.vars.example`） | `info` |

規則：字串值才採用；空字串 / `undefined` / `null` / 非字串偵測不到時回退預設值。
此層不包含任何機密欄位。

## `src/shared/keys.ts` — key 常數與小工具

Redis / 佇列 / 計量的命名常數（與來源逐一對應），供 batch-creator（→ Worker routes）
與 batch-process（→ 金流核心）共用命名：

- 佇列／頻道常數：`GLOBAL_QUEUE`、`FINALIZE_QUEUE`、`EVENTS_CHANNEL`、`WORKERS_SET`
- 時間窗口：`WINDOW_MS = 250`
- key 小工具：`requestsKey(mode)`、`dbWritesKey(mode)`、`processingKey(workerId)`、
  `aliveKey(workerId)`、`resultKey(taskId)`

## `src/shared/events.ts` — 領域事件 log 部分

原 PoC 的 `emitEvent` 既寫 stdout log 也發布 Redis pub/sub（ioredis）。本模組依
Worker 環境調整，只移植「事件 log」部分且平台無關（無 node:/ioredis 依賴）：

- `formatEventLog(event): string` —— 純函式，依 `DomainEvent` 建構單行 log（與來源
  `console.log` 格式逐一對應，如 `[event] Committed account=acct-1 ver=3 bal=1000`）。
- `emitEventLog(event, logger?)` —— 輸出 log；`logger` 可注入以便測試，預設 `console.log`。

Redis 廣播屬平台 binding 語意，留至 Item 6，本層不引入。

## 測試

`npm test` 涵蓋三個模組的契約（keys 常數、config 缺省回退、events log 格式）。
測試經「01-test（契約先行、紅燈）→ 02-impl（實作轉綠）」拆層開發。
