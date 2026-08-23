# Factory 工作項表單內容：uber_payment_poc → Cloudflare Worker 移植（第 1 期）

> 產出日期：2026-08-23。欄位對應 `.github/ISSUE_TEMPLATE/factory-work-item.yml`
> （Backstage「開立 Factory 工作項」表單欄位與此 1:1）。所有 item 的
> **目標 repo = `philipz/uber_payment_cloudflare_worker`**；
> dispatch 參數：`repo=philipz/uber_payment_cloudflare_worker`、`base_branch=software-factory`（絕非 main，Q-P2-1 guard）。
> 前置：`.github/factory/risk-paths.yml` 已依移植結構精準化（H2 金流核心明確列出、H3 只留真機密）。

---

## Item 1 — bootstrap 測試基礎設施

**任務類型**：`agent-write-docs`（就近對應；表單無 scaffold 型，PRD 明講）

**需求描述（PRD）**：
- 目標模組/檔案：根目錄 — `package.json`、`tsconfig.json`、`wrangler.toml`（placeholder 無真機密）、`vitest.config.ts`（含 `@cloudflare/vitest-plugin`）、`.dev.vars.example`、`docs/dev-setup.md`；既有 `.github/workflows/test.yml` 的 guard 因 package.json 出現而自然生效
- 做什麼（一句話）：建立 Cloudflare Worker（TypeScript）專案骨架與測試基礎設施，`npm ci && npm test` 綠燈、`npx wrangler dev` 可啟動
- 為什麼：空骨架 repo 需 package.json 解鎖 dependabot npm 生態（`dependabot.yml` 已預留註記）與 factory「測試紅→綠」DoD
- 範圍（不碰什麼）：不實作業務邏輯；不建真實 secret（`.dev.vars` 只給 example）；不動 guardrail

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：`npm ci && npm test` 綠燈（含 smoke test）、`npx wrangler dev` 可啟動、`docs/dev-setup.md` 提供逐步實作說明
- [x] 不觸碰高風險路徑：依精準化後 placeholder 設定不屬 H3 真機密範圍
- [x] 跑測試確認綠燈：CI Tests workflow 在 PR 綠燈

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 2 — 移植純邏輯 A：operations（測試先行）

**任務類型**：`agent-add-tests`

**需求描述（PRD）**：
- 目標模組/檔案：`src/shared/operations.ts` + `test/unit/operations.test.ts`（自來源 repo `uber_payment_poc` 移植）
- 做什麼（一句話）：`applyOperation`/`replayBatch`/`dedupeTransactions` 原樣移植，**不修改任何餘額運算規則**，契約 = 來源既有測試斷言
- 為什麼：金流純函式地基；測試先行確保語意不變
- 範圍（不碰什麼）：不碰平台 API（DO/D1/Queues）；不修改運算規則；不引入新依賴

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：unit 測試移植且紅→綠（斷言與來源一致）；邏輯與來源逐行比對
- [x] 不觸碰高風險路徑：依 Q19(a) 誠實框架（邏輯不變移植）；若 agent 依 SR2（金流計算）停手 → needs-human 由人類接手
- [x] 跑測試確認綠燈：`npm run test:unit` + CI 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 3 — 移植純邏輯 B：microuac（Buffer→DataView）

**任務類型**：`agent-add-tests`

**需求描述（PRD）**：
- 目標模組/檔案：`src/shared/microuac.ts` + unit 測試
- 做什麼（一句話）：移植 48-byte 佈局（**位元組相容**，保留 MD5 收斂），`Buffer`/`readBigInt64BE` 改 `DataView`/`Uint8Array`（或 nodejs_compat），MD5 用純 JS 實作（WebCrypto 無 MD5）
- 為什麼：審計格式與來源逐位元組相容（Shadow System 對照願景）
- 範圍（不碰什麼）：不改佈局/欄位/位元組序；不改 hash 演算法

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：48-byte round-trip 測試紅→綠（斷言與來源一致）
- [x] 不觸碰高風險路徑：依 Q19(a) 誠實框架；停手兜底同 Item 2
- [x] 跑測試確認綠燈：`npm run test:unit` + CI 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 4 — 移植純邏輯 C：config/types/keys/events log

**任務類型**：`agent-add-tests`

**需求描述（PRD）**：
- 目標模組/檔案：`src/shared/{config,types,keys,events}.ts` + 對應 unit 測試
- 做什麼（一句話）：移植環境設定解析、契約型別、key 常數、事件 log 部分（依 Worker 環境調整，無 node:http 依賴）
- 為什麼：平台無關契約層；後續金流核心移植的依賴
- 範圍（不碰什麼）：不引入 DO/D1/Queues binding 讀取邏輯（留給 Item 6）；不建真實 secret

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：unit 測試紅→綠
- [x] 不觸碰高風險路徑：config 若涉機密依精準化後 H3 判定
- [x] 跑測試確認綠燈：`npm run test:unit` + CI 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 5 — 金流核心 01-test 層：契約與整合測試（`it.skip` 提交）

**任務類型**：`agent-add-tests`

**需求描述（PRD）**：
- 目標模組/檔案：`test/`（契約測試）
- 做什麼（一句話）：定義移植後金流語意的可驗證契約（紅燈）：250ms 窗口歸集、OCC 版本衝突重試、Exactly-Once 冪等、審計原子性 — 以 `@cloudflare/vitest-plugin` 在 miniflare 上對 DO/D1/Queues bindings 寫整合測試，**`it.skip` 提交**（斷言完整、該層 CI 綠；紅燈驗證在沙箱完成）
- 為什麼：測試深度 = 金流核心「紅→綠」根基；契約先行給 Item 6 人類實作明確目標
- 範圍（不碰什麼）：只寫測試與契約、不實作；不觸碰 guardrail

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：契約測試以 `it.skip` 提交且 CI 綠（紅燈在沙箱驗證）；斷言未刪弱
- [x] 不觸碰高風險路徑：語意涉金流依 Q19(a) 誠實框架（只定義契約、不實作運算）；SR2 停手則 needs-human
- [x] 跑測試確認綠燈：`npm run test:unit` + CI 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 6 — 金流核心 02-impl 層（人類主導，不 dispatch）

**追蹤方式**：開 factory issue（型別就近 `agent-add-tests`）但**不 dispatch**；人類直接在 `software-factory` 分支實作並開 PR。

**需求描述（PRD）**：
- 目標模組/檔案：平台綁定層 — **Durable Object**（Hot Account 串行化 + 250ms 窗口歸集 + 可靠佇列/心跳/重認領；事件驅動 lazy flush + alarm 兜底，狀態持久化）、**D1**（accounts/audit/processed_transactions，OCC 條件 UPDATE + `batch()` 原子）、**Queues**（finalize 下游，at-least-once + 冪等去重）、純 JS MD5
- 做什麼（一句話）：依 Item 5 契約把紅燈測試 un-skip 並實作至全綠（Exactly-Once = at-least-once + 冪等鍵原子去重）
- 為什麼：SR2 金流計算 → 人類主導；平台語意重設計是移植成敗核心
- 範圍（不碰什麼）：依 Item 5 契約；不自動合併（review tier）；審計位元組相容驗證

**驗收標準（DoD）**（人類工作項）：
- [x] 有可驗證的測試/驗證方式：Item 5 契約測試由紅轉綠（un-skip）；全部測試綠
- [x] 不觸碰高風險路徑：本 item 即金流核心（H2）——人類主導，不進 factory dispatch
- [x] 跑測試確認綠燈：`npm run test:unit` + CI 綠；審計位元組相容（與來源 `microUacFor` 產出比對）

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 7 — docs：執行與部署手冊

**任務類型**：`agent-write-docs`

**需求描述（PRD）**：
- 目標模組/檔案：`docs/`（dev-setup 延伸、deploy-guide、architecture-mapping）
- 做什麼（一句話）：撰寫本機執行（`wrangler dev` + miniflare 測試）、部署步驟（人類手動 `wrangler deploy` + `wrangler secret put`）、來源語意 → DO/D1/Queues 對映表
- 為什麼：部署由人類手動需要步驟文件；留存可依循文件
- 範圍（不碰什麼）：只寫文件；描述的行為須與實作一致（未實作部分標註「規劃中」）

**驗收標準（DoD）**：
- [x] 有可驗證的測試/驗證方式：依文件步驟可重現 `wrangler dev`/`npm test`/部署
- [x] 不觸碰高風險路徑：`docs/` 不屬風險路徑
- [x] 跑測試確認綠燈：CI 綠（文件改動）

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## 執行順序

1. ✅ 前置：risk-paths 精準化修訂（本文件同批提交）
2. Item 1 → 2 → 3 → 4（factory dispatch，可依 factory-pr-stacking 串聯；每張 PR base = software-factory）
3. Item 5（契約測試 `it.skip`）→ Item 6（人類 un-skip + 實作，不 dispatch）
4. Item 7（docs）
5. 人類手動部署（`wrangler deploy`，非 factory 步驟）

## 失敗模式與兜底

- **SR2 停手**（Item 2/3/5）：→ needs-human → 人類接手（已接受；非失敗）
- **miniflare 無法測試某語意**：契約測試降級 unit + 人類 `wrangler dev` 手動驗證
- **D1 互動交易不可用**：OCC 改 `batch()` + 衝突檢查重試（Item 6 決策）
- **審計位元組相容性失敗**：與來源 `microUacFor`/`packMicroUAC` 逐欄位對照除錯
