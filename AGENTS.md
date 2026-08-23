# Repository Guidelines

> **現況**：本 repo 目前為空骨架（僅 LICENSE），Cloudflare Worker 專案尚未落地。下列指引分
> 「已生效」與「待落地」兩部分——工廠（software factory）規範已生效；專案慣例待骨架落地後補齊。

## Factory（軟體工廠）— 已生效
- 依 `.dsh/skills/` 的 factory-workflow 處理工作項：讀 Issue → 測試先行 → 實作 → 自審 → 拆 stacked PR → 寫 `.factory/run/report.json`。
- stacked PR 的 base 一律為 `software-factory` 分支（**絕不 push 到 main**）；分支命名 `factory/<issue編號>-<nn>-<layer>`（見 factory-pr-stacking）。
- 觸發 factory-stop-rules 任一規則即停手並貼 `needs-human`；不得修改 guardrail（`.github/**`、`CODEOWNERS`、`catalog-info.yaml`、`.dsh/skills/**`）。
- Commit 採 Conventional Commits（`feat:` / `fix:` / `test:` / `docs:` / `chore:`）。

## Project Structure（待落地 — 依 Cloudflare Worker + TypeScript 慣例）
- 預期結構：`src/index.ts`（fetch handler 入口）、`src/routes/` 或 `src/handlers/`、`src/shared/`（共用模組）、`migrations/`（D1 SQL）、`test/`；設定檔 `wrangler.toml` + `.dev.vars`（gitignored）。
- 結構盤點與風險路徑以 `.github/factory/risk-paths.yml` 的 pattern 為準——該檔目前為**預先宣告**，程式碼落地後需依實際結構修訂。

## Build, Test & Development Commands（待落地）
- 骨架落地後補齊並更新本節：`npm ci`、`npm run test`（vitest）、`npx wrangler dev`、`npx wrangler deploy`。
- CI（`.github/workflows/test.yml`）目前以 guard 跳過測試（尚無 `package.json`）；一旦骨架落地即自動生效。

## Configuration & Operations Tips
- 機密一律走 Cloudflare secrets（`wrangler secret put`），不 commit；`.dev.vars` 僅供本機、已 gitignored。
- 涉及 D1/KV/R2 的行為需本機 `npx wrangler dev` 驗證；測試避免依賴外部服務（見 factory-work-item 的 DoD）。
