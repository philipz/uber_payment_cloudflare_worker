# Quint 符合性確認：specs/uber-payment.qnt 對照程式碼與驗證證據

> 產出日期：2026-08-25。目的：使用已完成的 Quint 規格（issue #25，PR #30/#31，
> merged at `8ff8d83`）確認**規格**與**程式碼**都符合 Quint 定義的限制條件。
> 本文檔是驗證證據的固化產物；所有命令皆可在本 repo 重現（環境：quint 0.32.0、
> Node 22.21.1、npm 套件 `@informalsystems/quint@^0.32.0`）。

---

## 0. 結論

**規格與程式碼目前完全符合 Quint 定義的限制條件。**

- `quint typecheck specs/uber-payment.qnt` — ✅ 無錯誤
- `quint verify specs/uber-payment.qnt --main uber_payment --max-steps 6 --invariants <9 條>`（Apalache）— ✅ **No violation found**（9 條不變量全部成立）
- `quint test specs/uber-payment.qnt --main uber_payment_test` — ✅ 通過（純函式 + 狀態機情境）
- `npm run test:oracle`（神諭 harness：模型 ITF traces vs TS `operations.ts`）— ✅ 5/5
- `npm test`（全量）— ✅ 46/46（8 files）

Quint 規格中的**不變量（invariant）即限制條件**；第 1 節逐條列出每條不變量在程式碼中
的對應位置與滿足方式。第 2 節是原始工具輸出摘要；第 3 節誠實列出覆蓋缺口。

---

## 1. 9 條不變量 → 程式碼對照（限制條件逐條核對）

來源規格基準：`docs/Payment Batching PoC Specs.md`（250ms 窗口 / Hot Account /
Exactly-Once / SLA）、`CONTEXT.md`、`docs/adr/0001`、README（對帳 SQL 語意）。

| # | 不變量（quint 名稱） | 限制條件語意 | 程式碼對應位置 | 滿足方式 |
| --- | --- | --- | --- | --- |
| 1 | `balanceEqualsSignedSum` | 餘額 = Σ 帶符號金額（op 1,4 → +；2,3 → −） | `src/shared/operations.ts` `applyOperation`/`replayBatch`；`src/platform/account-do.ts` `commitBatch` | 純函式逐筆套用；commit 以 `replayBatch(acc.balance, deduped)` 計算新餘額 |
| 2 | `auditEqualsProcessed` | 每筆已處理交易恰一條審計 | `commitBatch` 內 processed INSERT + audit INSERT 同一 `db.batch()` | 同 batch 原子提交；`changes()` 門控保證 stale batch 兩者皆不寫 |
| 3 | `versionMonotonic` | 版本單調、每成功批次恰 +1 | `commitBatch` 條件 UPDATE `SET version = version + 1 WHERE version = ?` | OCC 版本推進；單一寫入者（DO）使衝突結構性不可能 |
| 4 | `windowBoundary` | windowStart 恆落 250ms 網格 | `src/platform/account-do.ts` `accumulate` | `Math.floor(now / WINDOW_MS) * WINDOW_MS`（`WINDOW_MS = 250`） |
| 5 | `accountAffinity` | 同帳戶批次互不交疊、批次交易屬該帳戶 | `src/index.ts` 路由 + `src/platform/account-do.ts` | `idFromName(accountId)` 路由到單一 DO 實例（單一寫入者） |
| 6 | `opInRange` | 操作碼合法（1..4） | `src/shared/types.ts` `OperationType`（0x01–0x04）；`src/index.ts` `parseTxn` | enum 常數 + 入站驗證（非法 op → 400） |
| 7 | `amountPositive` | 金額為正整數（最小貨幣單位） | `src/index.ts` `parseTxn` | `Number.isInteger(amount) && amount > 0` |
| 8 | `microUac48` | MicroUAC 48-byte 佈局與欄位可表示範圍 | `src/shared/microuac.ts` `packMicroUAC`/`unpackMicroUAC`；`src/platform/micro-uac-for.ts` | 欄位 offset/size 與 spec 逐一對應（8+1+8+2+4+16+4+5 = 48）；unit/契約測試驗證位元組相容 |
| 9 | `statusCommitted` | 審計狀態恆為 Committed | `commitBatch` audit INSERT `status = 'Committed'` | 審計與餘額同交易原子落庫；Tentative 為 stub（與來源一致） |

### 純函式層對照（oracle harness 驗證）

神諭 harness（`test/quint/uber-payment-oracle.test.ts`）以 Quint 模型為 oracle：`quint run`
產生 ITF traces，逐一與 TS `operations.ts` 比對：

- 每帳戶：TS `replayBatch(0, 審計 ops)` == 模型餘額（對照不變量 1）
- 每筆審計：TS `applyOperation(0)` 帶符號 == 模型 `signedAmount`（op 1,4 → +；2,3 → −）
- 審計 txnIds 集合 == processed 集合（對照不變量 2）
- TS `dedupeTransactions`：全部已處理 → 空（at-least-once 冪等語意）

---

## 2. 驗證命令與原始輸出

### 2.1 typecheck

```
$ quint typecheck specs/uber-payment.qnt
（無輸出 = 成功）
```

### 2.2 Apalache 正式驗證（9 條不變量）

```
$ quint verify specs/uber-payment.qnt --main uber_payment --max-steps 6 \
    --invariants balanceEqualsSignedSum auditEqualsProcessed versionMonotonic \
    windowBoundary accountAffinity opInRange amountPositive microUac48 statusCommitted
...
State 6: state invariant 0 holds. ...（每條逐一確認 holds）
The outcome is: NoError
[ok] No violation found (172462ms).
```

> 172s 為本機實測（含 Apalache 啟動）；CI 的 quint-verify workflow timeout 15min 充足。
> `--invariants` 空格分隔為 quint 0.32.0 支援的語法（與 `.github/workflows/quint-verify.yml` 一致）。

### 2.3 run 情境測試（spec module `uber_payment_test`）

```
$ quint test specs/uber-payment.qnt --main uber_payment_test
  uber_payment_test
（exit 0 = 全部 run 情境通過）
```

> quint 0.32.0 的 `quint test` 輸出極簡（僅印 module 名）；exit 0 代表所有 `run` 情境
> （applyOperationTests / dedupeTests / ingestThenCommitScenario /
> idempotentRedeliveryScenario / invalidOpBlocked）通過。以故意失敗的 probe 實測確認：
> 情境失敗時 CLI 輸出 `error: Tests failed` 且非零 exit——因此 exit 0 即全綠。需要看執行
> 細節可用 `--verbosity=3`。

### 2.4 神諭 harness

```
$ npm run test:oracle
 RUN  v4.1.11
 ✓ test/quint/uber-payment-oracle.test.ts (5 tests) 1907ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 2.5 全量測試（含 Item 6 契約測試）

```
$ npm test
 ✓ test/unit/operations.test.ts (10 tests)
 ✓ test/unit/microuac.test.ts (4 tests)
 ✓ test/unit/events.test.ts (6 tests)
 ✓ test/unit/config.test.ts (5 tests)
 ✓ test/unit/keys.test.ts (7 tests)
 ✓ test/unit/md5.test.ts (4 tests)
 ✓ test/smoke.test.ts (2 tests)
 ✓ test/contract/core.test.ts (8 tests)
 Test Files  8 passed (8)
      Tests  46 passed (46)
```

---

## 3. 覆蓋缺口（誠實聲明）

以下為**已知但可接受**的覆蓋邊界，不修改 spec 以迎合；留作後續工作項（見
`docs/quint-conformance.md` 對照的移植工作項規劃）。

1. **Oracle 僅涵蓋 `operations.ts` 純函式**：`microuac.ts` 48-byte 位元組佈局目前由
   unit/契約測試（`test/unit/microuac.test.ts`、`test/contract/core.test.ts`）涵蓋，
   未納入 quint oracle 的逐 trace 比對——可作為後續 oracle 擴充（對照 spec 的
   `microUac48` 不變量）。
2. **`quint verify` 狀態空間為有界抽象**：`AccountIds = 1.to(1)`、`TransactionIds = 1.to(2)`、
   `Amounts = 1.to(1)`、`--max-steps 6`。這是有意設計（Apalache 性能），平台層
   （DO/D1/Queues 編排、alarm、OCC 重試）不進模型，由 `test/contract/core.test.ts` 涵蓋。
3. **模型不含平台並發**：單一寫入者使衝突結構性不可能；`MAX_OCC_RETRIES` 為防禦性
   guard，模型未建模並發衝突路徑（與來源「衝突重試」語意一致，非缺口）。
4. **`windowBoundary` 為網格抽象**：模型用 `Grids = Set(0, WINDOW)` 表示 250ms 網格上
   的兩格；程式碼用 `Math.floor(now / 250) * 250` 即時計算——兩者語意一致，但模型未
   窮舉所有可能的 now 值（有界抽象）。

---

## 4. 重現方式

```bash
npx quint typecheck specs/uber-payment.qnt
npx quint verify specs/uber-payment.qnt --main uber_payment --max-steps 6 \
  --invariants balanceEqualsSignedSum auditEqualsProcessed versionMonotonic \
  windowBoundary accountAffinity opInRange amountPositive microUac48 statusCommitted
npx quint test specs/uber-payment.qnt --main uber_payment_test
npm run test:oracle
npm test
```

CI 對應：`.github/workflows/quint-verify.yml`（gate + typecheck + verify + oracle，
PR 觸及 `quint-paths.yml` 宣告路徑時為 required check）。
