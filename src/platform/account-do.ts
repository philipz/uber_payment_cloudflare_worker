// Account Durable Object —— Hot Account 串行化 + 250ms 窗口歸集 + OCC 提交（Item 6）。
//
// 語意對應（來源 uber_payment_poc）：
//   - Hot Account 串行化：以 accountId 為 DO id，同一帳戶所有請求路由到同一實例（單一寫入者），
//     等同來源「Redis 對單一 key 的串行化」，無需自行加鎖。
//   - 250ms 窗口：事件驅動 lazy flush + alarm 兜底（§2.5：alarm 最壞延遲 1 分鐘，
//     不能依賴準時；有持續請求時按 deadline 準時 flush，冷批次接受 alarm 延遲）。
//   - Buffer 必須持久化（hibernation 會丟記憶體）——寫入 ctx.storage，載入時還原。
//   - OCC：D1 `db.batch()` 原子交易內「條件 UPDATE + 冪等 INSERT + 審計 INSERT」；
//     單一寫入者使衝突結構性不可能，guard 為防禦性（來源 MAX_OCC_RETRIES=20 語意）。
//   - Exactly-Once = at-least-once 佇列 + processed_transactions 冪等去重（§6.1）。
import { DurableObject } from 'cloudflare:workers';
import { dedupeTransactions, replayBatch } from '../shared/operations';
import { TxnState, type DomainEvent, type TransactionInput } from '../shared/types';
import type { Env } from './env';
import { microUacFor } from './micro-uac-for';

export const WINDOW_MS = 250;
export const MAX_BATCH_TXNS = 100;
export const MAX_OCC_RETRIES = 20;
const FLUSH_RETRY_MS = 500; // commit 失敗時 alarm 重試間隔（at-least-once）

interface AccumulateRequest {
  type: 'accumulate';
  accountId: string;
  txn: TransactionInput;
}

interface FlushRequest {
  type: 'flush';
  accountId: string;
}

export class AccountDO extends DurableObject<Env> {
  private buffer: TransactionInput[] | null = null;
  private windowStart: number | null = null;
  private accountId: string | null = null;
  private readonly storage = this.ctx.storage;

  private async ensureLoaded(): Promise<void> {
    if (this.buffer !== null) return;
    this.buffer = (await this.storage.get<TransactionInput[]>('buffer')) ?? [];
    this.windowStart = (await this.storage.get<number>('windowStart')) ?? null;
    this.accountId = (await this.storage.get<string>('accountId')) ?? null;
  }

  private async persist(): Promise<void> {
    await this.storage.put('buffer', this.buffer ?? []);
    await this.storage.put('windowStart', this.windowStart);
    if (this.accountId !== null) await this.storage.put('accountId', this.accountId);
  }

  async fetch(request: Request): Promise<Response> {
    const req = (await request.json()) as AccumulateRequest | FlushRequest;
    if (req.type === 'accumulate') {
      const res = await this.accumulate(req.accountId, req.txn);
      return Response.json(res);
    }
    if (req.type === 'flush') {
      const res = await this.flush(req.accountId);
      return Response.json(res);
    }
    return new Response('Not Found', { status: 404 });
  }

  /** alarm 兜底：到期窗口未 flush 時由 alarm 觸發（alarm 可能延遲 ≤1 分鐘，可接受）。 */
  async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (this.accountId === null || this.buffer === null || this.buffer.length === 0) return;
    if (this.windowStart !== null && Date.now() >= this.windowStart + WINDOW_MS) {
      await this.flush(this.accountId);
    } else {
      // 未到期（例如 commit 失敗後的 retry alarm）——重設 alarm 到下一個 deadline
      await this.storage.setAlarm((this.windowStart ?? Date.now()) + WINDOW_MS);
    }
  }

  /** 入站交易：加入窗口 buffer；deadline 已過或 buffer 滿則 lazy flush。 */
  async accumulate(accountId: string, txn: TransactionInput): Promise<{ ok: boolean; windowStart: number; buffered: number }> {
    await this.ensureLoaded();
    this.accountId = accountId;
    const now = Date.now();

    // 上一個窗口已到期 → 先 flush 再開新窗口
    if (this.windowStart !== null && now >= this.windowStart + WINDOW_MS) {
      await this.flush(accountId);
      await this.ensureLoaded();
    }

    if (this.windowStart === null || this.buffer!.length === 0) {
      this.windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
      this.buffer = [];
      await this.storage.setAlarm(this.windowStart + WINDOW_MS);
    }

    this.buffer!.push(txn);
    await this.persist();

    if (now >= this.windowStart + WINDOW_MS || this.buffer!.length >= MAX_BATCH_TXNS) {
      await this.flush(accountId);
      await this.ensureLoaded();
    }

    return { ok: true, windowStart: this.windowStart, buffered: this.buffer!.length };
  }

  /** 關窗：組成 batch → D1 原子提交（OCC + 冪等 + 審計）→ Queues 下游通知。 */
  async flush(accountId: string): Promise<{ ok: boolean; count: number; batchId?: string }> {
    await this.ensureLoaded();
    if (this.buffer === null || this.buffer.length === 0 || this.windowStart === null) {
      this.windowStart = null;
      this.buffer = [];
      await this.storage.deleteAlarm();
      await this.persist();
      return { ok: true, count: 0 };
    }

    const txns = this.buffer;
    const windowStart = this.windowStart;
    const batchId = `${accountId}:${windowStart}`;

    try {
      await this.commitBatch(accountId, batchId, windowStart, txns);
      // 提交成功才清 buffer（失敗保留 → alarm 重試；重複提交由冪等去重吸收）
      this.buffer = [];
      this.windowStart = null;
      await this.storage.deleteAlarm();
      await this.persist();
      return { ok: true, count: txns.length, batchId };
    } catch (err) {
      // at-least-once：保留 buffer，alarm 稍後重試
      await this.storage.setAlarm(Date.now() + FLUSH_RETRY_MS);
      throw err;
    }
  }

  /** D1 原子提交：OCC 條件 UPDATE + processed 冪等 INSERT + audit INSERT（48-byte MicroUAC）。 */
  private async commitBatch(
    accountId: string,
    batchId: string,
    windowStart: number,
    txns: TransactionInput[],
  ): Promise<void> {
    // D1 Sessions（first-primary）：read-your-writes 消除讀副本延遲競態（研究 §1.2 實測教訓）——
    // DO 提交後下一次 flush 若讀到舊版本，OCC 重試的 stale batch 會寫入無 guard 的 audit 列
    // （processed 有 ON CONFLICT 擋、audit 無），造成 audit 多寫。session 讓同 commit 內讀寫一致。
    // 雙層防護（遠端實測 2026-08-23：同窗口兩次 flush 可併發——平台輸入閘對 D1 子請求不持鎖）：
    //  1) D1 Sessions first-primary：同 commit 內 read-your-writes；
    //  2) changes() 門控：batch 中 UPDATE 影響 0 列（版本不符/stale）時，processed 與 audit 的
    //     INSERT...SELECT...WHERE changes()=1 整批不寫——D1 batch 只對「語句失敗」rollback，
    //     不對「UPDATE 0 列」rollback，門控讓 stale batch 完全無副作用，重試即乾淨。
    const session = this.env.DB.withSession('first-primary');
    for (let attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
      const acc = await session
        .prepare('SELECT balance, version FROM accounts WHERE id = ?')
        .bind(accountId)
        .first<{ balance: number; version: number }>();
      if (!acc) {
        // 帳戶不存在 → 自動建立（與來源「種子後任意帳戶可收單」語意一致；並發首筆由 OR IGNORE 吸收）
        await session
          .prepare('INSERT OR IGNORE INTO accounts (id, balance, version) VALUES (?, 0, 0)')
          .bind(accountId)
          .run();
        continue;
      }

      // 冪等去重：排除已套用與批次內重複（來源 dedupeTransactions 語意）
      const processed = await session
        .prepare('SELECT transaction_id FROM processed_transactions WHERE account_id = ?')
        .bind(accountId)
        .all<{ transaction_id: string }>();
      const processedSet = new Set(processed.results.map((r) => r.transaction_id));
      const deduped = dedupeTransactions(txns, processedSet);

      if (deduped.length === 0) return; // 全部已處理（重複提交被吸收）

      const { newBalance, steps } = replayBatch(acc.balance, deduped);
      const newVersion = acc.version + 1;
      const nowSec = Math.floor(Date.now() / 1000);

      const stmts: D1PreparedStatement[] = [
        session
          .prepare('UPDATE accounts SET balance = ?, version = version + 1 WHERE id = ? AND version = ?')
          .bind(newBalance, accountId, acc.version),
        ...deduped.map((t, i) =>
          session
            .prepare(
              'INSERT INTO processed_transactions (transaction_id, account_id, applied_version, balance_after, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(transaction_id) DO NOTHING',
            )
            .bind(t.transactionId, accountId, newVersion, steps[i].balanceAfter, nowSec),
        ),
        ...deduped.map((t, i) =>
          session
            .prepare('INSERT INTO audit (account_id, micro_uac, status, created_at) SELECT ?, ?, ?, ? WHERE changes() = 1')
            .bind(
              accountId,
              microUacFor({
                transactionId: t.transactionId,
                referenceId: t.referenceId,
                operationType: t.operationType,
                amount: t.amount,
                sequenceNumber: i + 1,
                accountVersion: newVersion,
                businessTime: t.businessTime ?? nowSec,
              }),
              'Committed',
              nowSec,
            ),
        ),
      ];

      const results = await session.batch(stmts);
      // 單一寫入者：版本衝突結構性不可能；guard 為防禦性（來源 OCC 語意），衝突時 jitter 重試
      if (results[0].meta.changes === 0) {
        const jitter = 5 + Math.random() * 20;
        await new Promise((r) => setTimeout(r, jitter));
        continue;
      }

      // 下游通知（at-least-once；consumer 僅 log，遺失不影響審計——與來源 post-process 同語意）
      await this.env.FINALIZE_QUEUE.send({ accountId, batchId, count: deduped.length });

      // 領域事件發布（Item 8，H7 人類核可）：commit 成功後發布 Committed 事件到 EventHub DO。
      // 純觀測 hook——零計算/審計/版本邏輯改動；發布失敗不影響主流程（與來源 emitEvent
      // non-blocking 語意一致，廣播遺失不影響審計正確性）。
      const event: DomainEvent = {
        ts: Date.now(),
        state: TxnState.Committed,
        accountId,
        batchId,
        size: deduped.length,
        version: newVersion,
        balance: newBalance,
      };
      await this.publishEvent(event).catch(() => {
        /* 事件廣播失敗 non-blocking（來源 emitEvent 同語意） */
      });
      return;
    }
    throw new Error(`OCC conflict exceeded retries for account ${accountId}`);
  }

  /** 發布領域事件到 EventHub DO（單一 hub 實例；Item 8）。 */
  private async publishEvent(event: DomainEvent): Promise<void> {
    const hub = this.env.EVENT_HUB.get(this.env.EVENT_HUB.idFromName('hub'));
    await hub.fetch('https://hub/publish', {
      method: 'POST',
      body: JSON.stringify({ type: 'publish', event } satisfies { type: 'publish'; event: DomainEvent }),
    });
  }
}
