# E2E Runbook — 對已部署 Cloudflare Worker 的最終驗收測試

> 適用對象：`uber-payment-cloudflare-worker`（部署位址見 `README.md`）。
> 目的：對**生產環境**做最終端到端驗收——行為（API）+ 資料（D1 對帳）雙重確認。
> 每次驗證用**新帳戶隔離**，跑完清理，不污染生產資料。

## 前置

```bash
B=https://uber-payment-cloudflare-worker.philipz.workers.dev   # 部署 URL（依實際替換）
cd <repo>                                                      # 需 wrangler 認證
npx wrangler whoami
```

---

## Phase 0 — 前置檢查

```bash
# 作用中部署版本（應為最新、100%）
npx wrangler deployments list

# 健康檢查
curl -s $B/health          # → {"status":"ok",...}
curl -s $B/                # → OK

# 佇列（finalize-queue 1 producer/1 consumer + dlq）
npx wrangler queues list
```

---

## Phase 1 — 功能 E2E

### S1 單筆交易流程

```bash
curl -X POST "$B/accounts/e2e-final-1/transactions" \
  -H 'content-type: application/json' \
  -d '{"transactionId":"s1a","operationType":1,"amount":100}'
sleep 1.5   # 等窗口關閉（250ms + alarm 容差）
curl -s $B/accounts/e2e-final-1
# 預期：{"balance":100,"version":1,"auditCount":1,"processedCount":1}
```

### S2 同窗口批次歸集（並發 N 筆 → 單一窗口一次提交）

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST "$B/accounts/e2e-final-1/transactions" \
    -H 'content-type: application/json' \
    -d "{\"transactionId\":\"sb$i\",\"operationType\":1,\"amount\":10}" &
done
wait
sleep 1.5
curl -s $B/accounts/e2e-final-1
# 預期：balance=150；version 只 +1（不是 +5）＝批次歸集成功
```

### S3 冪等（同 transactionId 重送）

```bash
curl -s -X POST "$B/accounts/e2e-final-1/transactions" \
  -H 'content-type: application/json' \
  -d '{"transactionId":"s1a","operationType":1,"amount":100}'
sleep 1.5
curl -s $B/accounts/e2e-final-1
# 預期：balance 不變、auditCount/processedCount 不增
```

### S4 跨窗口版本推進

```bash
for id in c1 c2 c3; do
  curl -s -X POST "$B/accounts/e2e-final-1/transactions" \
    -H 'content-type: application/json' \
    -d "{\"transactionId\":\"$id\",\"operationType\":1,\"amount\":1}"
  sleep 1.5   # 慢速 → 各自成窗
done
curl -s $B/accounts/e2e-final-1
# 預期：version 每窗 +1
```

### S5 四種操作

```bash
# Credit(1) 增加 / Debit(2) 減少 / Authorize(3) 保留扣減 / Release(4) 回補
curl -s -X POST "$B/accounts/e2e-final-1/transactions" -H 'content-type: application/json' \
  -d '{"transactionId":"op-debit","operationType":2,"amount":50}'; sleep 1.5
curl -s $B/accounts/e2e-final-1   # balance 減少 50
curl -s -X POST "$B/accounts/e2e-final-1/transactions" -H 'content-type: application/json' \
  -d '{"transactionId":"op-auth","operationType":3,"amount":10}'; sleep 1.5
curl -s $B/accounts/e2e-final-1   # balance 減少 10（保留扣減）
curl -s -X POST "$B/accounts/e2e-final-1/transactions" -H 'content-type: application/json' \
  -d '{"transactionId":"op-rel","operationType":4,"amount":10}'; sleep 1.5
curl -s $B/accounts/e2e-final-1   # balance 增加 10（回補）
```

### S6 錯誤路徑

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/accounts/e2e-final-1/transactions" \
  -H 'content-type: application/json' -d '{"transactionId":"","operationType":1,"amount":1}'   # 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/accounts/e2e-final-1/transactions" \
  -H 'content-type: application/json' -d '{"transactionId":"x","operationType":99,"amount":1}'  # 400
curl -s -o /dev/null -w "%{http_code}\n" $B/accounts/no-such-account                          # 404
```

---

## Phase 2 — 資料完整性對帳（D1 直接驗證）⭐

解碼 `audit.micro_uac` 與帳戶餘額對帳 — **API 只測行為，對帳才驗資料**。

```bash
# 審計解碼：op(offset 9) + amount(offset 10, 8B big-endian signed) + accountVersion(offset 20, 4B)
npx wrangler d1 execute DB --remote \
  --command "SELECT id, hex(substr(micro_uac,9,1)) AS op_hex, hex(substr(micro_uac,10,8)) AS amt_hex, \
             hex(substr(micro_uac,20,4)) AS ver_hex FROM audit WHERE account_id='e2e-final-1' ORDER BY id" \
  --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
SIGN={1:1,2:-1,3:-1,4:1}   # Credit:+ Debit:- Authorize:- Release:+
total=0
for r in d[0]['results']:
    op=int(r['op_hex'],16); amt=int.from_bytes(bytes.fromhex(r['amt_hex']),'big',signed=True)
    total+=amt*SIGN[op]
print(f'簽名金額總和: {total}')
assert total == <accounts.balance>, '對帳不符'
print('✅ 對帳一致')"
```

再確認三表一致：

```bash
npx wrangler d1 execute DB --remote \
  --command "SELECT (SELECT balance FROM accounts WHERE id='e2e-final-1') AS balance, \
                    (SELECT COUNT(*) FROM audit WHERE account_id='e2e-final-1') AS aud, \
                    (SELECT COUNT(*) FROM processed_transactions WHERE account_id='e2e-final-1') AS proc"
# 預期：audit count == processed count；簽名金額總和 == balance
```

> ⚠️ **關鍵陷阱**：MicroUAC 的 `amount` 存**正數大小**，方向由 `operationType` 決定（與 `operations.ts` 的 `applyOperation` 語意一致）— 對帳必須帶符號，否則會誤判成 bug。

---

## Phase 3 — 下游/佇列（finalize）

```bash
npx wrangler tail --format pretty   # 另開終端機
# 發一筆交易後應看到：
#   (log) [finalize] account=... batch=... count=...
#   Queue finalize-queue (N messages) - Ok
```

---

## Phase 4 — 清理

```bash
npx wrangler d1 execute DB --remote \
  --command "DELETE FROM audit WHERE account_id LIKE 'e2e-final%'; \
             DELETE FROM processed_transactions WHERE account_id LIKE 'e2e-final%'; \
             DELETE FROM accounts WHERE id LIKE 'e2e-final%'"
```

---

## 方法論要點

1. **新帳戶隔離**：每個情境用唯一帳戶（`e2e-final-*`），跑完刪除。
2. **行為 + 資料雙重驗證**：API 斷言（balance/version）+ D1 對帳（審計解碼）。只測 API 會漏掉資料層 bug（審計重複即為例 — API 看不出、對帳才暴露）。
3. **批次歸集的判據**：並發 N 筆 → version 只 +1 代表歸集成功（+N 代表失敗）。
4. **冪等與錯誤路徑必測**：金流系統最容易出事的兩類。
5. **remote-only bug**：`wrangler tail` 即時日誌 + `wrangler d1 execute --remote` 直接查庫；需要時在程式碼加暫時 `console.log` 部署後定位（定位完移除）。
