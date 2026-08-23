-- uber_payment_cloudflare_worker — D1 schema（移植自 uber_payment_poc db/init.sql，Item 6）
-- 語意對應：
--   accounts（主賬本 + 樂觀鎖版本）→ accounts
--   processed_transactions（交易級冪等）→ processed_transactions
--   audit（MicroUAC 48-byte 審計）→ audit
-- 狀態：Item 6 第 1 期僅寫 'Committed'（審計與餘額同交易原子落庫，Tentative 為 stub，與來源一致）。

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  applied_version INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_account ON processed_transactions(account_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  micro_uac BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Tentative','Committed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit(account_id);

-- 種子熱點帳戶（與來源一致：balance 0、version 0）
INSERT OR IGNORE INTO accounts (id, balance, version) VALUES ('hot-account-1', 0, 0);
