# Factory 工作項表單內容：uber_payment_poc → Cloudflare Worker 移植（第 2 期）

> 產出日期：2026-08-25。承接 `docs/factory-work-items-cloudflare-port.md`（第 1 期，Items 1–7
> 已全部完成並合併）。第 2 期為 `docs/architecture-mapping.md`「未實作（規劃中）」與
> README §10「已知限制與後續」所列項目的工作項化。
> 欄位對應 `.github/ISSUE_TEMPLATE/factory-work-item.yml`；所有 item 的
> **目標 repo = `philipz/uber_payment_cloudflare_worker`**；
> dispatch 參數：`repo=philipz/uber_payment_cloudflare_worker`、`base_branch=software-factory`
> （絕非 main，Q-P2-1 guard）。
> 前置：`docs/quint-conformance.md` 已確認規格與程式碼符合 Quint 限制（9 條不變量全綠），
> 第 2 期任何涉及金流語意的變更都須維持該符合性（spec 變更需人類核准）。

---

## Item 8 — SSE 儀表板 + 領域事件廣播（`EVENTS_CHANNEL`）

**任務類型**：`agent-add-tests`（契約先行）；路由/事件契約涉 H7 → 人類核可

**需求描述（PRD）**：
- 目標模組/檔案：`src/index.ts`（新增 `/events` SSE 路由、`/dashboard` 靜態頁）、
  `src/shared/events.ts`（補「廣播」語意，目前只移 log 部分）、`test/contract/`（SSE 契約測試）
- 做什麼（一句話）：移植來源 `batch-creator/dashboard.ts`（127 行單頁儀表板，EventSource
  訂閱 `/events`）+ Redis pub/sub 事件廣播的 Worker 對應——DO 內事件驅動或 Queues consumer
  → SSE fan-out；審計已由主交易原子落庫，廣播純觀測不影響正確性
- 為什麼：來源儀表板是「即時觀察狀態機流轉（Ingested→…→Finalized）、餘額/版本、AZ 競爭」
  的可觀測性資產；README §10 明列第 1 期不含 dashboard/SSE
- 範圍（不碰什麼）：不修改餘額/審計/版本計算（H2 金流核心不動）；不改 `EVENTS_CHANNEL`
  常數語意（`keys.ts` 已有）；不建真實 secret

**驗收標準（DoD）**：
- [ ] 有可驗證的測試/驗證方式：SSE 契約測試紅→綠（`curl /events` 收到 `Committed` 事件；
  `/dashboard` 回 HTML）；不影響既有 46 tests + quint 9 不變量
- [ ] 不觸碰高風險路徑：`src/index.ts`/`src/**/events.ts` 屬 H7（對外 API/事件契約）——
  路由與事件 payload 格式需人類核可後才動；`DASHBOARD_HTML` 純靜態資產與金流無關
- [ ] 跑測試確認綠燈：`npm run test:unit` + CI 綠；`quint-verify` gate 若觸發則維持綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 9 — load-generator 壓測對照（batched vs naive）

**任務類型**：`agent-add-tests`（runner 純邏輯 + 測試）；naive 基準線定義需人類核可

**需求描述（PRD）**：
- 目標模組/檔案：`scripts/` 或 `src/services/load-generator/`（runner 移植，來源 95 行）、
  `/metrics` 或對帳方式（見範圍）、`test/`（比較邏輯 unit 測試）
- 做什麼（一句話）：移植來源 `load-generator/index.ts` + `runner.ts`（`ScenarioResult`：
  requests / dbWrites / ratio / throughput / avgLatencyMs）的 Worker 版，對熱點帳戶灌負載
  並輸出「batched 壓縮比」對照
- 為什麼：來源核心論證「250ms 窗口把 N 筆 DB 寫入壓縮為 1 筆」需要可重現的壓測對照資產
  （README §10 明列第 1 期不含 load-generator）
- 範圍（不碰什麼）：不碰金流計算本身（H2）；「naive 基準線」在 Worker 無對應（來源是
  naive 模式直接讀-改-寫）——需人類先裁決：以 D1 直接單筆寫為基準，或以來源紀錄為基準

**驗收標準（DoD）**：
- [ ] 有可驗證的測試/驗證方式：runner 對照輸出格式與來源一致；`ratio ≥ 1` 合理斷言測試；
  `npm run test:unit` + CI 綠
- [ ] 不觸碰高風險路徑：runner 純邏輯不屬風險路徑；若新增 `/metrics` 對外端點則涉 H7，
  需人類核可
- [ ] 跑測試確認綠燈：`npm run test:unit` + CI 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 10 — post-process 全功能（Tentative → Finalized 狀態流 + Finalized 事件）

**任務類型**：`agent-add-tests`；金流語意 → 人類主導

**需求描述（PRD）**：
- 目標模組/檔案：`src/index.ts` queue consumer（目前僅 log）、`src/shared/types.ts`
  （若需 Finalized 事件欄位）、`migrations/`（若 audit 狀態流需 schema 支援，涉 H6）、
  `test/contract/`
- 做什麼（一句話）：把來源 `post-process/index.ts`（Kafka stub + Finalized 事件發布）對應
  到 Worker——consumer 補 `Finalized` 領域事件發布；Tentative 狀態流目前與來源一致為
  stub，是否補實需人類裁決（涉審計語意與 spec 的 `statusCommitted` 不變量）
- 為什麼：README §10 明列 post-process 為 log stub、審計 Tentative 為 stub
- 範圍（不碰什麼）：不弱化審計原子性（`db.batch()` + `changes()` 門控不動）；不重複寫
  審計（審計已主交易落庫，下游僅傳播）

**驗收標準（DoD）**：
- [ ] 有可驗證的測試/驗證方式：consumer 發布 Finalized 事件的契約測試紅→綠；
  `quint verify` 的 `auditEqualsProcessed` / `statusCommitted` / `balanceEqualsSignedSum`
  迴歸不破（spec 若因狀態流改變而需調整 → 先呈報人類核准 spec diff）
- [ ] 不觸碰高風險路徑：審計/狀態流屬 H2（金流核心）→ 人類主導；migrations 屬 H6
- [ ] 跑測試確認綠燈：`npm run test:unit` + CI 綠 + `quint-verify` 綠

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## Item 11 — 可靠佇列心跳/重認領：文件標註（不移植）

**任務類型**：`agent-write-docs`（已在 `docs/architecture-mapping.md` 完成，2026-08-25）

**需求描述（PRD）**：
- 目標模組/檔案：`docs/architecture-mapping.md`（對映表 + 未實作節）
- 做什麼（一句話）：把「可靠佇列 worker 心跳/重認領（`WORKERS_SET`、BLMOVE）」標為
  **不移植（已取代）**——被 DO 單一寫入者取代，非「待移植」項目
- 為什麼：避免後續排程誤把已取代語意當成 backlog；`keys.ts` 小工具僅保留來源追溯
- 範圍（不碰什麼）：不改 `keys.ts`；不改 guardrail

**驗收標準（DoD）**：
- [x] 文件用語一致：對映表「不移植（已取代）」+ 未實作節同標
- [x] 不觸碰高風險路徑：`docs/` 不屬風險路徑
- [x] 跑測試確認綠燈：CI 綠（docs 改動）

**目標 repo**：`philipz/uber_payment_cloudflare_worker`

---

## 執行順序

1. ✅ 前置：`docs/quint-conformance.md`（第 2 期符合性基準，2026-08-25 完成）
2. ✅ Item 11（docs，最小，已隨本文件完成）
3. Item 8（SSE）→ Item 10（post-process）→ Item 9（load-generator）——每項獨立 stacked
   PR（base = `software-factory`）；H2/H7 部分由人類主導，agent 只做非金流切片

## 失敗模式與兜底

- **SSE 在 Workers 的長連線限制**：SSE 路由若無法維持連線 → 降級為 log + 輪詢
  （契約測試斷言事件格式即可）；或改用 WebSocket DO（另立工作項）
- **naive 基準線無對應**：Item 9 需人類先定「naive 定義」再實作
- **狀態流改變影響 quint 不變量**：Item 10 若動 `statusCommitted` 語意 → 依 quint-execute-spec
  的 spec 變更協議先呈報人類核准，再動 code
