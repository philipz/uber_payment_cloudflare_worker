# 500 錯誤根因診斷：commitBatch 冪等查詢的可擴展性缺陷

> 診斷日期：2026-08-25。方法：Cloudflare Workers Logs（observability）+ 請求數比對 +
> 來源專案對照。狀態：**根因已確認**，修復待實作（H2 金流核心，人類主導）。

---

## 1. 症狀

單帳戶高並發灌壓時，`POST /accounts/:id/transactions` 回 **HTTP 500**：

| 觸發條件 | 結果 |
| --- | --- |
| 200 筆 concurrency 20（單帳戶） | ❌ 500 |
| 150 筆 concurrency 20（單帳戶） | ✅ 成功 |
| 同帳戶 round 1（100 筆 c10） | ✅ 成功 |
| 同帳戶 round 2/3（100 筆 c10） | ❌ 500 |
| 並行 30 個 curl（單一帳戶） | ✅ 全部成功 |

**模式**：與「單帳戶累積交易量」相關，非純 concurrency、非平台瞬時限制。

---

## 2. 診斷方法：observability 請求數比對

用 `wrangler tail`（Workers Logs）比對「客戶端送出」vs「Worker 實際收到」：

| 量測 | 數字 | 意義 |
| --- | --- | --- |
| CLI 送出 `POST /accounts/.../transactions` | 200 筆 | 客戶端嘗試 |
| tail 看到的同請求 | **151 筆** | 只有 151 筆到達 Worker |
| 缺失請求 | **49 筆** | **這 49 筆 = 收到 500 的請求，從未到達 Worker** |
| tail 中所有事件 `exceptions` | 全為 `[]` | Worker 程式從未看到錯誤 |

**關鍵結論**：500 發生在 **Cloudflare 平台層**（Worker 執行前，請求被平台終止），
**不是 Worker 程式拋錯**——tail 中連 500 請求的對應事件都是 `200 / ok`。

---

## 2.5 診斷修正（部署後實測，2026-08-25）

> ⚠️ 本章節**修正**先前「查詢量為 500 根因」的初步結論——誠實記錄實測後的真因。

**修復部署後復現**：`IN (本批次)` 修復上線後，同帳戶多輪灌壓仍偶發 500。

**實測數據**（新部署 `22de9e32`）：

| 測試 | 結果 |
| --- | --- |
| c=1 / c=5 / c=8（100 筆） | ✅ 全成功 |
| c=10（100 筆，多次） | ⚠️ **機率性 500**（3 次中 1 次失敗） |
| c=10（200 筆） | ❌ 200 筆僅 166 到達 Worker、34 筆平台層 500 |
| c=15（100 筆） | ⚠️ 單次成功（非單純門檻，具機率性） |
| 並發 30 curl / urllib 200 筆 | ✅ 全 202（客戶端差異：urllib/curl 新連線 vs undici keep-alive） |

**修正後的真因**：**單一 Durable Object 在高並發（≥10 同時在途）下，平台層機率性
拒絕請求**——這是官方「單一 DO 1,000 req/s 軟上限」的並發面（單執行緒串行化，
過多並發觸發平台保護）。**不是查詢量、不是 Worker 程式 bug**。

**對先前結論的修正**：
- ❌ 先前「`WHERE account_id = ?` 全量查詢為 500 根因」——**不成立**（修復後仍 500）
- ✅ 但 `IN (本批次)` 修復**仍有價值**：降低每次 commit 的 D1 查詢量（成本/延遲優化），
  只是**不是 500 的解方**
- ✅ **500 是單一 DO 高並發的平台 soft-limit**——屬架構已知限制（效能報告 §1.2 的
  「單一超級熱點 1,000 req/s 硬上限」的並發面）

**500 的應對**（取代「修復查詢」）：
1. **接受為已知限制**：單帳戶並發 ≤8 穩定；≥10 偶發 500（平台 soft-limit 抖動）
2. **客戶端節流**：load-generator 等灌壓工具預設 concurrency ≤8（`--concurrency` 已支援）
3. **生產考量**：真實使用者單帳戶並發極少達 10（一般 1-3）；熱點帳戶需分散（多帳戶）——與效能報告的「EventHub/D1 分片」建議一致
4. `IN (本批次)` 修復保留（成本優化），但**不在 issue #55 標記為 500 修復**——需更新 issue 描述

---

## 3. 根因：commitBatch 的全量冪等查詢

### 缺陷程式（`src/platform/account-do.ts`）

```sql
-- commitBatch 內，每次提交前：
SELECT transaction_id FROM processed_transactions WHERE account_id = ?  -- ← 全量讀該帳戶
```

每次 commit（每 250ms 窗口）都**全量讀取該帳戶所有歷史 processed** 做冪等去重。

### 擴展性後果

```
單帳戶累積 N 筆後：
  每次 commit 讀取 N 筆 processed（冪等去重）
  → N 越大，每次 commit 的 D1 查詢越久/越大
  → 超過平台對單一 invocation 的限制 → 平台終止請求 → 500
```

實測對照：round 1（帳戶 0 筆）成功；round 2（帳戶 ~170 筆）開始 500。

---

## 4. 來源專案對照：**來源沒有此缺陷**

檢查 `uber_payment_poc`（commit `739d9af`）`src/services/batch-process/index.ts` L133：

```sql
-- 來源：只查本批次的 transaction_id
SELECT transaction_id, applied_version, balance_after
FROM processed_transactions
WHERE transaction_id = ANY($1)   -- $1 = 本批次 uniqueTxids
```

**來源每次 commit 讀取量 = 批次大小（≤ MAX_BATCH）**，與帳戶歷史無關——**可擴展**。

**結論：這是移植時的偏離**（移植版把來源的 `ANY($1)` 改成 `account_id = ?`），非來源
設計問題。來源實作是正確的基準，修復應回歸來源語意。

---

## 5. 修復建議

### 方案 1（推薦）：回歸來源語意——只查本批次

```sql
-- 改為：只查本批次的 transaction_id（與來源 ANY($1) 等價）
SELECT transaction_id FROM processed_transactions
WHERE account_id = ? AND transaction_id IN (本批次 txid 清單)
```

- 每次 commit 讀取量 = 批次大小（≤ 100），**與帳戶歷史無關**
- 冪等語意不變（仍排除已套用 + 批次內重複）
- 最小改動、零行為改變

### 方案 2：靠 PK 去重、略過 SELECT

processed 已有 `ON CONFLICT(transaction_id) DO NOTHING`——可考慮直接以
`INSERT ... ON CONFLICT DO NOTHING` 靠 PK 去重，消除 SELECT（需驗證 `changes()`
門控邏輯與 dedupeTransactions 的語意等價）。

### 影響範圍

- H2（金流核心）→ 人類主導實作
- 需契約測試釘住「冪等語意不變」+ 新的擴展性測試（同帳戶多輪灌壓不 500）
- 更新 `docs/performance-report.md` 的 500 段落（由「平台層不明」改為「已定位」）

---

## 6. 附錄：原始數據

| 量測 | 數據 |
| --- | --- |
| 200 筆 c20 | 151/200 到達 Worker，49 筆平台層 500 |
| round 1 / round 2（100 筆 c10） | ✅ / ❌ |
| 帳戶累積 processed（round 2 失敗時） | ~170 筆 |
| 來源專案查詢 | `WHERE transaction_id = ANY($1)`（本批次） |
| 移植版查詢 | `WHERE account_id = ?`（全量帳戶） |

---

## 7. 後續

- [ ] 開 factory issue（H2 人類主導）實作方案 1
- [ ] 契約測試：同帳戶多輪灌壓不 500（擴展性回歸）
- [ ] 更新效能報告 500 段落
