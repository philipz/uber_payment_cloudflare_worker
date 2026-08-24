// uber-payment —— 依照 uber_payment_poc 規格與限制的形式化模型（spec module）。
//
// 來源規格基準（issue #25 需求描述）：
//   docs/Payment Batching PoC Specs.md（250ms 窗口 / Hot Account / Exactly-Once / SLA）
//   CONTEXT.md（詞彙語意：Time Window / Account Version / Account Affinity / Exactly-Once）
//   docs/adr/0001（PoC 範圍）
//   README（不變量：餘額=Σ帶符號金額 / audit==processed / version 每批次 +1）
//
// 抽象模型語意（Q9b：純函式層 + 抽象狀態機；set 化批次為 Apalache 性能而設計）：
//   - 每帳戶一個 open batch（Account Affinity：互不交疊）；批次 txns 為 Set[int]
//   - txnInfo：交易不可變元數據（accountId/op/amount），ingest 時記錄
//   - ingest：交易進帳戶當下窗口（窗口 = 250ms 網格上一格，有界抽象時鐘）
//   - processBatch：pending（未處理）交易一次提交——版本每批次 +1、每筆一條
//     status=Committed 審計、冪等去重（set union 使同 txnId 重送自動去重）
//   - advanceTime：窗口滾動時 windowStart 在網格上翻轉（alarm/sweep 關窗的抽象）
module uber_payment {
  // --- 固定領域常數（pure val：op 代碼與佈局為協定事實，非可變參數）---
  pure val CREDIT: int = 1
  pure val DEBIT: int = 2
  pure val AUTHORIZE: int = 3
  pure val RELEASE: int = 4
  pure val OPS: Set[int] = Set(CREDIT, DEBIT, AUTHORIZE, RELEASE)
  pure val WINDOW: int = 250
  pure val STATUS_COMMITTED: int = 2

  // 驗證用有界領域（Apalache 探索規模；純值使 quint verify 預設 main 可直接執行）
  pure val AccountIds: Set[int] = 1.to(1)
  pure val TransactionIds: Set[int] = 1.to(2)
  pure val Amounts: Set[int] = 1.to(1)

  // MicroUAC 48-byte 佈局（Specs、microuac.ts）與欄位可表示範圍
  pure val MICRO_UAC_SIZE: int = 48
  pure val UAC_FIELD_BYTES: List[int] = List(8, 1, 8, 2, 4, 16, 4, 5)
  pure val INT64_MAX: int = 9223372036854775807
  pure val UINT32_MAX: int = 4294967295
  pure val UINT16_MAX: int = 65535
  pure val UINT8_MAX: int = 255

  // 窗口起點的有界抽象：權威時鐘分窗 = 250ms 網格上的一格（0 或 WINDOW）
  pure val Grids: Set[int] = Set(0, WINDOW)
  pure def flipWindow(ws: int): int = if (ws == 0) WINDOW else 0

  type TxnInfo = { accountId: int, op: int, amount: int }
  type Batch = { windowStart: int, txns: Set[int] }
  type AuditRec = { txnId: int, accountId: int, op: int, amount: int, version: int, seq: int, status: int }

  var accounts: int -> { balance: int, version: int }
  var openBatch: int -> Batch
  var txnInfo: int -> TxnInfo
  var processed: Set[int]
  var audit: int -> AuditRec

  // ==================== 純函式層（對應 src/shared/operations.ts） ====================
  // applyOperation 語意：Credit/Release 增加、Debit/Authorize 減少（Authorize=保留扣減、Release=回補）
  pure def signedAmount(op: int, amount: int): int =
    if (op == DEBIT or op == AUTHORIZE) (0 - amount) else amount

  pure def applyOp(balance: int, op: int, amount: int): int =
    balance + signedAmount(op, amount)

  // replayBatch 的最終餘額（Σ 帶符號金額；交換性使 set 版與 list 版等價——oracle 以 TS 逐筆驗證順序）
  def replayBalance(balance: int, txns: Set[int]): int =
    txns.fold(balance, (b, id) => b + signedAmount(opOf(id), amountOf(id)))

  // dedupeTransactions：排除已處理（set 語意：批次內重複由 set union 吸收）
  pure def dedupe(txns: Set[int], already: Set[int]): Set[int] =
    txns.exclude(already)

  // txnInfo 查詢（對未定義 txnId 的防禦性回退——不變量保證查詢前已 ingest）
  def opOf(id: int): int = if (txnInfo.keys().contains(id)) txnInfo.get(id).op else 0
  def amountOf(id: int): int = if (txnInfo.keys().contains(id)) txnInfo.get(id).amount else 0
  def accountOf(id: int): int = if (txnInfo.keys().contains(id)) txnInfo.get(id).accountId else 0

  // ==================== 狀態相依輔助 ====================
  def pendingOf(acc: int): Set[int] =
    openBatch.get(acc).txns.exclude(processed)

  def auditIdsOf(acc: int): Set[int] =
    audit.keys().filter(id => accountOf(id) == acc)

  // 所有在途（未提交）批次中的 txnId（全域唯一性：同 txnId 不得同時在兩個批次）
  def txnsInFlight: Set[int] =
    AccountIds.fold(Set(), (s, acc) => s.union(openBatch.get(acc).txns))

  // ==================== 動作 ====================
  action init = all {
    accounts' = AccountIds.mapBy(_ => { balance: 0, version: 0 }),
    openBatch' = AccountIds.mapBy(acc => { windowStart: 0, txns: Set() }),
    txnInfo' = Map(),
    processed' = Set(),
    audit' = Map(),
  }

  // 收單：交易進該帳戶當下窗口（窗口邊界由權威時鐘裁決；同 txnId 重送由 set union 自動去重）
  action ingest(acc: int, txnId: int, op: int, amount: int): bool = all {
    acc.in(AccountIds),
    txnId.in(TransactionIds),
    op.in(OPS),
    amount.in(Amounts),
    not(txnId.in(txnsInFlight)),
    accounts' = accounts,
    processed' = processed,
    audit' = audit,
    txnInfo' = txnInfo.put(txnId, { accountId: acc, op: op, amount: amount }),
    openBatch' = openBatch.put(acc, { ...openBatch.get(acc), txns: openBatch.get(acc).txns.union(Set(txnId)) }),
  }

  // 時間推進（有界抽象時鐘）：d=WINDOW 表示窗口滾動（windowStart 翻轉），d=1 窗口內推進
  action advanceTime(d: int): bool = all {
    d.in(Set(1, WINDOW)),
    accounts' = accounts,
    processed' = processed,
    audit' = audit,
    txnInfo' = txnInfo,
    openBatch' = AccountIds.mapBy(acc => {
      ...openBatch.get(acc),
      windowStart: if (d == WINDOW) flipWindow(openBatch.get(acc).windowStart) else openBatch.get(acc).windowStart,
    }),
  }

  // 提交批次（對應 batch-process：OCC 版本推進 + 冪等去重 + 審計原子落庫）
  // at-least-once：同 txnId 重送由 processed 去重吸收；pending 空 → 不動作
  action processBatch(acc: int): bool = {
    val pending = pendingOf(acc)
    val newVersion = accounts.get(acc).version + 1
    all {
      acc.in(AccountIds),
      pending.size() > 0,
      accounts' = accounts.put(acc, {
        balance: accounts.get(acc).balance + replayBalance(0, pending),
        version: newVersion,
      }),
      processed' = processed.union(pending),
      audit' = pending.fold(audit, (m, id) =>
        m.put(id, { txnId: id, accountId: acc, op: opOf(id), amount: amountOf(id), version: newVersion, seq: 0, status: STATUS_COMMITTED })),
      openBatch' = openBatch.put(acc, { ...openBatch.get(acc), txns: Set() }),
      txnInfo' = txnInfo,
    }
  }

  action step: bool = any {
    nondet acc = AccountIds.oneOf()
    nondet txnId = TransactionIds.oneOf()
    nondet op = OPS.oneOf()
    nondet amount = Amounts.oneOf()
    ingest(acc, txnId, op, amount),
    nondet acc2 = AccountIds.oneOf()
    processBatch(acc2),
    nondet d = Set(1, WINDOW).oneOf()
    advanceTime(d),
  }

  // ==================== 不變量（9 條，名稱與 quint-verify.yml 宣告一致） ====================
  // 1. 餘額 = Σ 帶符號金額（README 對帳 SQL：op 1,4 為 +；2,3 為 −）
  val balanceEqualsSignedSum: bool =
    AccountIds.forall(acc =>
      accounts.get(acc).balance ==
        auditIdsOf(acc).fold(0, (s, id) => s + signedAmount(audit.get(id).op, audit.get(id).amount)))

  // 2. audit 筆數 == processed 筆數（每筆已處理交易恰一條審計）
  val auditEqualsProcessed: bool =
    processed == audit.keys()

  // 3. 版本單調遞增、每成功批次恰 +1（當前版本 >= 審計記錄的最大版本）
  val versionMonotonic: bool =
    AccountIds.forall(acc => {
      val maxV = auditIdsOf(acc).fold(0, (m, id) => if (audit.get(id).version > m) audit.get(id).version else m)
      accounts.get(acc).version >= maxV and accounts.get(acc).version >= 0
    })

  // 4. 窗口邊界：windowStart 恆落在 250ms 網格上（權威時鐘分窗的有界抽象）
  val windowBoundary: bool =
    AccountIds.forall(acc => openBatch.get(acc).windowStart.in(Grids))

  // 5. Account Affinity：同帳戶請求歸集且互不交疊（批次交易屬該帳戶、無跨帳戶重疊）
  val accountAffinity: bool =
    AccountIds.forall(acc =>
      openBatch.get(acc).txns.forall(id => accountOf(id) == acc)) and
    AccountIds.forall(a1 =>
      AccountIds.forall(a2 =>
        a1 == a2 or
        openBatch.get(a1).txns.intersect(openBatch.get(a2).txns).size() == 0))

  // 6. 操作碼合法（1..4）
  val opInRange: bool =
    audit.keys().fold(true, (b, id) => b and audit.get(id).op.in(OPS)) and
    AccountIds.forall(acc => openBatch.get(acc).txns.forall(id => opOf(id).in(OPS)))

  // 7. 金額為正整數（最小貨幣單位）
  val amountPositive: bool =
    audit.keys().fold(true, (b, id) => b and audit.get(id).amount > 0) and
    AccountIds.forall(acc => openBatch.get(acc).txns.forall(id => amountOf(id) > 0))

  // 8. MicroUAC 48-byte 佈局與欄位可表示範圍（Int64/UInt8/UInt16/UInt32）
  val microUac48: bool =
    UAC_FIELD_BYTES.foldl(0, (s, b) => s + b) == MICRO_UAC_SIZE and
    audit.keys().fold(true, (b, id) =>
      b and audit.get(id).amount <= INT64_MAX and audit.get(id).amount >= (0 - INT64_MAX) and
      audit.get(id).version <= UINT32_MAX and audit.get(id).version >= 0 and
      audit.get(id).seq <= UINT16_MAX and audit.get(id).seq >= 0 and
      audit.get(id).op <= UINT8_MAX and audit.get(id).op >= 0)

  // 9. 審計狀態恆為 Committed（與餘額同交易原子落庫——實作只寫 Committed，Tentative 為 stub）
  val statusCommitted: bool =
    audit.keys().fold(true, (b, id) => b and audit.get(id).status == STATUS_COMMITTED)
}

// ==================== 測試 module（quint test） ====================
module uber_payment_test {
  import uber_payment.*

  // 純函式層測試（對應 test/unit/operations.test.ts 斷言）
  run applyOperationTests = all {
    applyOp(100, CREDIT, 50) == 150,
    applyOp(100, DEBIT, 30) == 70,
    applyOp(100, AUTHORIZE, 40) == 60,
    applyOp(100, RELEASE, 40) == 140,
    signedAmount(DEBIT, 5) == -5,
    signedAmount(RELEASE, 5) == 5,
  }

  run dedupeTests = all {
    dedupe(Set(1, 2), Set()) == Set(1, 2),
    dedupe(Set(1, 2), Set(1)) == Set(2),
  }

  // 狀態機情境：收單→提交（餘額/版本/審計一致）
  run ingestThenCommitScenario =
    init.then(ingest(1, 1, CREDIT, 1)).then(ingest(1, 2, DEBIT, 1)).then(processBatch(1))
      .expect(accounts.get(1).balance == 0)
      .expect(accounts.get(1).version == 1)
      .expect(processed == Set(1, 2))
      .expect(audit.keys().size() == 2)
      .expect(audit.keys().fold(true, (b, id) => b and audit.get(id).status == STATUS_COMMITTED))

  // 冪等情境：同 txnId 重送（at-least-once）只套用一次
  run idempotentRedeliveryScenario =
    init.then(ingest(1, 1, CREDIT, 1)).then(processBatch(1))
      .then(ingest(1, 1, CREDIT, 1))
      .expect(accounts.get(1).balance == 1)
      .expect(processed.size() == 1)
      .expect(audit.keys().size() == 1)

  // 無效操作被擋（op 不在 1..4 時 ingest 不動作）
  run invalidOpBlocked =
    init.then(ingest(1, 1, 99, 1).fail())
}
