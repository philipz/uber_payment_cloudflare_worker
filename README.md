# uber-payment-cloudflare-worker

將 [uber_payment_poc](https://github.com/philipz/uber_payment_poc)（單機 Node.js + Redis + Postgres 的高並發金融賬本批次處理 PoC）**移植到 Cloudflare Workers** 的實作。

- **技術棧**：TypeScript（strict）／ Cloudflare Workers ／ Durable Objects ／ D1（SQLite）／ Queues
- **部署位址**：<https://uber-payment-cloudflare-worker.philipz.workers.dev>
- **狀態**：Factory Items 1–7 全部完成（見 [軟體工廠](#軟體工廠software-factory)），核心 happy path 已部署並通過端到端驗證

---

## 1. 專案概述

來源專案 `uber_payment_poc` 解決「Hot Account（熱點賬戶）高並發」問題：同一帳戶在極短時間內的大量變更請求，以 **250ms 時間窗口歸集為批次**，由 worker 以 **樂觀並發控制（OCC）** 原子提交，達成 **Exactly-Once** 語意並留下 **MicroUAC 緊湊審計**。

本專案把這套語意搬到 Edge 平台：

| 來源語意（Redis + Postgres） | Cloudflare 對應 |
|---|---|
| Redis TIME 權威時鐘 + Lua 原子窗口歸集（`ACCUMULATE_LUA` / `CLOSE_ONE_LUA` / `SWEEP_LUA`） | **Account Durable Object**：單一寫入者串行化 + 250ms 窗口歸集（事件驅動 lazy flush + alarm 兜底） |
| Redis 全域佇列 / processing list / 心跳 / 重認領（BLMOVE / LREM / `RECLAIM_LUA`） | Account DO 內部的持久化 buffer + alarm 重試；Exactly-Once 由「at-least-once + 冪等去重」達成 |
| Postgres 單一 DB 交易（OCC 條件 UPDATE + 冪等 INSERT + 審計 INSERT） | **D1 `batch()` 原子交易** + `changes()` 門控 + D1 Sessions（first-primary） |
| Redis Pub/Sub → SSE 儀表板 | **Queues** finalize 下游通知（consumer 為 post-process stub） |
| `microUacFor`（MD5 收斂 48-byte MicroUAC） | **純 JS MD5**（RFC 1321，位元組相容）+ `micro-uac-for` |

---

## 2. 架構總覽

```
┌─────────────────────────────────────────────────────────────┐
│  Client                                                      │
│  POST /accounts/:id/transactions  GET /accounts/:id  /health │
└───────────────┬─────────────────────────────────────────────┘
                │ 路由（src/index.ts，薄 handler）
┌───────────────▼─────────────────────────────────────────────┐
│  Account DO（src/platform/account-do.ts）                    │
│  每個帳戶一個實例（idFromName(accountId)）＝單一寫入者        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 250ms 窗口 buffer（持久化至 DO storage，防 hibernation）│  │
│  │ 事件驅動 lazy flush + alarm 兜底（alarm 最壞延遲 1 分）  │  │
│  └───────────────────────────┬────────────────────────────┘  │
│                              │ flush（關窗 → 組成 batch）     │
└──────────────────────────────▼──────────────────────────────┘
                 │ db.batch() 原子交易（OCC + 冪等 + 審計）
                 │ 1. UPDATE accounts SET balance, version+1 WHERE version=?
                 │ 2. INSERT processed_transactions … WHERE changes()=1
                 │ 3. INSERT audit (48-byte MicroUAC) … WHERE changes()=1
                 ▼
   ┌─────────────────────┐      ┌──────────────────────────┐
   │  D1（SQLite）        │      │  Queues finalize-queue   │
   │  accounts            │      │  at-least-once 下游通知  │
   │  processed_transactions│     │  consumer：僅 log        │
   │  audit（MicroUAC）    │      └──────────────────────────┘
   └─────────────────────┘
```

### 目錄結構

```
src/
├── index.ts                  # Worker 入口：路由 + queue consumer + DO class 匯出
├── shared/                   # 純 TS 領域層（移植自來源，邏輯不變）
│   ├── types.ts              # 契約型別（OperationType / TransactionInput / Task …）
│   ├── operations.ts         # applyOperation / replayBatch / dedupeTransactions（金流純函式）
│   └── microuac.ts           # 48-byte MicroUAC 編解碼（Buffer→Uint8Array/DataView，位元組相容）
└── platform/                 # 平台綁定層
    ├── account-do.ts         # Account Durable Object（核心）
    ├── env.ts                # Env bindings 型別
    ├── md5.ts                # 純 JS MD5（RFC 1321）
    └── micro-uac-for.ts      # microUacFor：transactionId MD5 前 8 bytes→Int64、referenceId MD5→16B
migrations/
└── 0001_init.sql             # D1 schema（accounts / processed_transactions / audit + 種子）
test/
├── unit/                     # 純邏輯測試（operations / microuac / md5 / config / keys / events）
└── contract/core.test.ts     # 金流契約整合測試（@cloudflare/vitest-plugin，workerd 內跑）
wrangler.toml                 # bindings：D1（DB）/ DO（ACCOUNT_DO）/ Queues（FINALIZE_QUEUE）
```

---

## 3. 核心元件細節

### 3.1 Account DO（`src/platform/account-do.ts`）

- **Hot Account 串行化**：`env.ACCOUNT_DO.get(idFromName(accountId))` — 同一帳戶所有請求路由到同一 DO 實例（單一執行緒、強一致 storage），等同來源「Redis 對單一 key 的串行化」，**無需自行加鎖**。
- **250ms 窗口歸集**：入站交易加入持久化 buffer；`windowStart = floor(now/250)*250`；**事件驅動 lazy flush**（deadline 已過或 buffer ≥100 筆立即關窗）+ **alarm 兜底**（窗口到期未收新請求時由 alarm 觸發；alarm 最壞延遲 1 分鐘，冷批次可接受）。Buffer 寫入 DO storage，hibernation 不丟失。
- **OCC 原子提交**（見 3.3）。
- **Exactly-Once** = at-least-once 佇列 + `processed_transactions` 冪等去重（來源語意，research §6.1）。

### 3.2 D1 schema（`migrations/0001_init.sql`）

```sql
accounts(id TEXT PK, balance INTEGER, version INTEGER)          -- 主賬本 + 樂觀鎖
processed_transactions(transaction_id TEXT PK, account_id,
  applied_version, balance_after, created_at)                    -- 交易級冪等
audit(id INTEGER PK AUTOINCREMENT, account_id,
  micro_uac BLOB, status CHECK IN ('Tentative','Committed'), created_at)  -- MicroUAC 審計
-- 種子：hot-account-1（balance 0, version 0）
```

- 第 1 期僅寫 `'Committed'`（審計與餘額同交易原子落庫；`Tentative` 為 stub — 與來源一致）。
- 非種子帳戶首筆交易**自動建立**（INSERT OR IGNORE）。

### 3.3 OCC 原子提交（雙層防護）

```sql
-- db.batch() 內三類語句，全部原子（任一語句失敗整批 rollback）
UPDATE accounts SET balance=?, version=version+1 WHERE id=? AND version=?;   -- OCC
INSERT INTO processed_transactions (...) SELECT … WHERE changes()=1 ON CONFLICT(transaction_id) DO NOTHING;
INSERT INTO audit (… micro_uac …) SELECT … WHERE changes()=1;
```

- **D1 Sessions（first-primary）**：同一次 commit 內 read-your-writes，消除讀副本延遲競態。
- **`changes()` 門控**：D1 `batch()` 只對「語句失敗」rollback，不對「UPDATE 影響 0 列」rollback — 若無門控，版本不符的 stale batch 仍會寫入 processed/audit（遠端實測的審計重複根因）。`WHERE changes()=1` 讓 stale batch 整批無副作用，OCC 重試（MAX_OCC_RETRIES=20 + jitter）即乾淨。
- 提交成功後 `FINALIZE_QUEUE.send()` 下游通知；失敗保留 buffer 由 alarm 重試（重複提交由冪等吸收）。

### 3.4 MicroUAC 審計（位元組相容）

48-byte big-endian 佈局與來源完全一致（Q11a）：

```
0  TransactionID  Int64    ← MD5(transactionId) 前 8 bytes 收斂
8  OperationType  UInt8    ← Credit=0x01 / Debit=0x02 / Authorize=0x03 / Release=0x04
9  Amount         Int64    ← 最小貨幣單位
17 SequenceNumber UInt16   ← 批次內順序
19 AccountVersion UInt32   ← 提交後賬戶版本
23 ReferenceHash  Binary16 ← MD5(referenceId)
39 BusinessTime   UInt32   ← Unix 秒
43 Reserved       Binary5
```

純 JS MD5（RFC 1321）位元組與 `node:crypto` 一致（unit 測試以標準向量驗證），保留未來 Shadow System 交叉比對可能。

---

## 4. API

| Method | Path | 說明 |
|---|---|---|
| `GET` | `/` | 骨架 smoke（回 `OK`） |
| `GET` | `/health` | 健康檢查 |
| `POST` | `/accounts/:id/transactions` | 收單（`202 Accepted`；窗口歸集非同步提交）。Body：`{transactionId, operationType(1-4), amount(正整數), referenceId?, businessTime?}` |
| `GET` | `/accounts/:id` | 查詢餘額/版本/審計筆數（驗證用） |

---

## 5. 關鍵設計決策

1. **Exactly-Once 端到端不可能**（End-to-End Argument + FLP）→ **at-least-once + 冪等鍵原子去重**（Queues 官方做法）。
2. **250ms 精確視窗不能靠 alarm/cron 準時性**（alarm 最壞延遲 1 分鐘）→ 事件驅動 lazy flush + alarm 兜底，buffer 持久化。
3. **單一寫入者**（Account DO）使 OCC 衝突結構性不可能；條件 UPDATE + changes() 門控為防禦性 + 併發安全（遠端實測修復）。
4. **審計與餘額同交易原子落庫**（來源 issue #16 語意），杜絕「有變更無審計」。
5. **位元組相容 MicroUAC + 純 JS MD5**（Workers 無 node:crypto、WebCrypto 無 MD5）。

---

## 6. 本機開發

```bash
npm ci
npx wrangler d1 migrations apply DB --local     # 本機 D1 建表 + 種子
npx wrangler dev --port 8787                     # 本機 workerd（DO/D1/Queues 全 local）
npm test                                         # vitest（unit + 契約整合，@cloudflare/vitest-plugin）
npm run test:watch
```

端到端手動驗證：

```bash
curl -X POST http://127.0.0.1:8787/accounts/demo/transactions \
  -H 'content-type: application/json' \
  -d '{"transactionId":"t1","operationType":1,"amount":100}'
curl http://127.0.0.1:8787/accounts/demo    # → {"balance":100,"version":1,"auditCount":1,"processedCount":1}
```

---

## 7. 測試

| 套件 | 內容 |
|---|---|
| `test/unit/operations.test.ts` | 餘額運算 / 批次重放 / 去重（斷言與來源一致） |
| `test/unit/microuac.test.ts` | 48-byte round-trip（DataView 版） |
| `test/unit/md5.test.ts` | RFC 1321 標準向量（位元組相容根基） |
| `test/unit/config|keys|events.test.ts` | 環境設定 / key 常數 / 事件 |
| `test/contract/core.test.ts` | **金流契約**：窗口歸集原子提交、Exactly-Once 冪等、DO 並發串行化、MicroUAC 位元組相容、alarm 兜底、種子帳戶、400/404 |

共 **46 個測試**；`vitest.config.ts` 以 miniflare 套用 D1 migrations（`?raw` 讀 .sql，單一來源）並啟用 `nodejs_compat`（僅測試環境）。

---

## 8. 部署

```bash
npx wrangler login                       # 認證（需 Workers/D1/Queues 權限）
npx wrangler d1 create uber-payment-poc  # 取得 database_id → 更新 wrangler.toml
npx wrangler d1 migrations apply DB --remote
npx wrangler queues create finalize-queue
npx wrangler queues create finalize-dlq
npx wrangler deploy
```

部署後驗證：`curl https://<name>.<account>.workers.dev/health`。

---

## 9. 軟體工廠（software factory）

本 repo 已配置軟體工廠全套機制（比照 spring-modulith-orders）：

- `.dsh/skills/factory-*`：factory-workflow / stop-rules / pr-stacking / self-review
- `.github/ISSUE_TEMPLATE/factory-work-item.yml`：開立工作項表單
- `.github/factory/`：risk-paths（H1–H7 硬規則）、task-template-*
- `.github/workflows/`：factory-issue-check / Tests / Security Scan / CodeQL
- 工廠 trunk = **`software-factory` 分支**（agent 絕不 push main，Q-P2-1）
- 金流核心（SR2）由**人類主導**，factory agent 只負責非金流工作項

**工作項狀態**：Items 1–7 全部完成（bootstrap → operations → microuac → config/keys/events → 契約測試 → 金流核心 → docs）。

---

## 10. 已知限制與後續

- **單帳戶 DO 軟上限 ~1,000 req/s**；超限排隊，隊滿回 `overloaded`。
- **alarm 延遲**：冷批次（無新請求）的窗口關閉可能延遲至 alarm 到點（最壞 1 分鐘）；有持續請求時按 deadline 準時。
- **D1 寫入計費較貴**（$1.00/M rows written）— 窗口歸集合併寫入正是省錢關鍵。
- **第 1 期範圍**（Q7a）：不含 dashboard/SSE、load-generator 壓測對照、多 AZ worker；post-process 為 log stub。
- **審計 `Tentative` 狀態**為 stub（與來源一致）。
- 來源語意完整對映表見 `docs/factory-work-items-cloudflare-port.md`；移植可行性研究見 software_factory 的 `docs/17-cf-workers-porting-research.md`。
