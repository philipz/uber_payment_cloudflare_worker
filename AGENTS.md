# Repository Guidelines

> **現況**：Cloudflare Worker 專案已落地（`src/` + `test/` + `migrations/` + `specs/`），77 tests 全綠。
> 工廠（software factory）規範採用**集中化 guardrail 架構（ADR-012）**：機制 repo
> （`philipz/software_factory`）是唯一事實來源，本 repo **不持有會漂移的副本**——無
> `.dsh/skills`、無 factory-issue-check workflow、無 task-template / issue-template 副本。

## Factory（軟體工廠）
- **Skills 單一事實來源在 software_factory 的 `.dsh/skills/`**（本 repo 無 `.dsh/skills`）：
  - CI：factory-run 會把 skills 同步到 `$HOME/.dsh/skills`（DSH rank 400 user-dsh）供 agent 載入；
  - 本機：在 `~/.dsh/settings.yaml` 設定 `skill-filesystem.customSkillDirs` 指向 software_factory checkout（rank 300）：
    ```yaml
    skill-filesystem:
      customSkillDirs:
        - /path/to/software_factory/.dsh/skills
    ```
  - 依 factory-workflow 處理工作項：讀 Issue → 測試先行 → 實作 → 自審 → 拆 stacked PR → 寫 `.factory/run/report.json`。
- **Issue 格式檢查集中於 factory-run 首步**（ADR-011 三行留言：格式合規＋複雜度分析＋建議模型），
  不合規即紅燈停派；開立工作項統一走 Backstage（建 Issue → dispatch factory-run）。
- stacked PR 的 base 一律為 `software-factory` 分支（**絕不 push 到 main**）；分支命名
  `factory/<issue編號>-<nn>-<layer>`（見 factory-pr-stacking）。
- 觸發 factory-stop-rules 任一規則即停手並貼 `needs-human`；不得修改 guardrail
  （`.github/**`、`CODEOWNERS`、`catalog-info.yaml`）。
- Commit 採 Conventional Commits（`feat:` / `fix:` / `test:` / `docs:` / `chore:`）。

## Project Structure（Cloudflare Worker + TypeScript）
- `src/index.ts`（fetch handler 入口）、`src/platform/`（DO / 路由語意對映層）、
  `src/shared/`（共用模組）、`migrations/`（D1 SQL）、`test/`（unit / contract / quint）、
  `specs/`（Quint 規格）、`scripts/`（load-generator）。
- 結構盤點與風險路徑以 `.github/factory/risk-paths.yml` 的 pattern 為準
  （H2：`src/platform/**`、`src/shared/operations.ts`、`src/shared/microuac.ts`；H7：`src/index.ts`、`src/**/events.ts`）。

## Build, Test & Development Commands
- `npm ci`、`npm run test`（vitest + cloudflare plugin，workerd 環境）、`npm run test:oracle`（Quint oracle，純 Node）。
- `npx wrangler dev`（本機）、`npx wrangler deploy`（部署）；機密走 `wrangler secret put`，`.dev.vars` 僅本機、已 gitignored。

## Configuration & Operations Tips
- 機密一律走 Cloudflare secrets（`wrangler secret put`），不 commit；`.dev.vars` 僅供本機、已 gitignored。
- 涉及 D1/KV/R2 的行為需本機 `npx wrangler dev` 驗證；測試避免依賴外部服務（見 factory-work-item 的 DoD）。
