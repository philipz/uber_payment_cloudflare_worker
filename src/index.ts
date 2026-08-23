// uber_payment_cloudflare_worker — Worker 入口（Item 6 金流核心，第 1 期）。
// 路由：
//   POST /accounts/:id/transactions   收單（202 Accepted；窗口歸集非同步提交）
//   GET  /accounts/:id                查詢餘額/版本/審計筆數（驗證用）
//   GET  /health                      健康檢查
//   GET  /                            骨架 smoke 用（回 OK）
// queue consumer：finalize 下游通知（post-process stub，僅 log——審計已由主交易原子落庫）
import { OperationType, type FinalizeJob, type TransactionInput } from './shared/types';
import type { Env } from './platform/env';

// DO class 必須可被 wrangler bundle 到達（class_name = "AccountDO"）
export { AccountDO } from './platform/account-do';

function parseTxn(body: unknown): TransactionInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.transactionId !== 'string' || b.transactionId.length === 0) return null;
  const op = Number(b.operationType);
  if (![OperationType.Credit, OperationType.Debit, OperationType.Authorize, OperationType.Release].includes(op)) {
    return null;
  }
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return {
    transactionId: b.transactionId,
    operationType: op as OperationType,
    amount,
    referenceId: typeof b.referenceId === 'string' ? b.referenceId : undefined,
    businessTime: typeof b.businessTime === 'number' ? b.businessTime : undefined,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('OK', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'uber-payment-cloudflare-worker' });
    }

    // POST /accounts/:id/transactions
    const m = url.pathname.match(/^\/accounts\/([^/]+)\/transactions$/);
    if (request.method === 'POST' && m) {
      const accountId = decodeURIComponent(m[1]);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid json' }, { status: 400 });
      }
      const txn = parseTxn(body);
      if (!txn) return Response.json({ error: 'invalid transaction' }, { status: 400 });

      // 路由到該帳戶的 Account DO（Hot Account 串行化）
      const stub = env.ACCOUNT_DO.get(env.ACCOUNT_DO.idFromName(accountId));
      const res = await stub.fetch('https://do/accumulate', {
        method: 'POST',
        body: JSON.stringify({ type: 'accumulate', accountId, txn } satisfies {
          type: 'accumulate';
          accountId: string;
          txn: TransactionInput;
        }),
      });
      return Response.json(await res.json(), { status: 202 });
    }

    // GET /accounts/:id（驗證用）
    const gm = url.pathname.match(/^\/accounts\/([^/]+)$/);
    if (request.method === 'GET' && gm) {
      const accountId = decodeURIComponent(gm[1]);
      const acc = await env.DB.prepare('SELECT balance, version FROM accounts WHERE id = ?')
        .bind(accountId)
        .first<{ balance: number; version: number }>();
      if (!acc) return Response.json({ error: 'account not found' }, { status: 404 });
      const audit = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit WHERE account_id = ?')
        .bind(accountId)
        .first<{ n: number }>();
      const processed = await env.DB.prepare('SELECT COUNT(*) AS n FROM processed_transactions WHERE account_id = ?')
        .bind(accountId)
        .first<{ n: number }>();
      return Response.json({
        accountId,
        balance: acc.balance,
        version: acc.version,
        auditCount: audit?.n ?? 0,
        processedCount: processed?.n ?? 0,
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  // finalize 下游通知（post-process stub；審計已由主交易原子落庫，此處僅傳播）
  async queue(batch: MessageBatch<FinalizeJob>): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      console.log(`[finalize] account=${job.accountId} batch=${job.batchId} count=${job.count}`);
    }
  },
} satisfies ExportedHandler<Env, FinalizeJob>;
