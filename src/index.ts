// uber_payment_cloudflare_worker — Worker 入口（Item 6 金流核心 + Item 8 SSE 儀表板 + Item 9 壓測對照）。
// 路由：
//   POST /accounts/:id/transactions   收單（202 Accepted；窗口歸集非同步提交）
//   GET  /accounts/:id                查詢餘額/版本/審計筆數（驗證用）
//   GET  /events                       SSE 訂閱（領域事件即時流；Item 8）
//   GET  /dashboard                    單頁儀表板（EventSource 訂閱 /events；Item 8）
//   GET  /metrics                      D1 對帳計數（Item 9；batched vs naive 壓縮比對照）
//   GET  /health                      健康檢查
//   GET  /                            骨架 smoke 用（回 OK）
// queue consumer：finalize 下游通知（post-process stub，僅 log——審計已由主交易原子落庫）
import { OperationType, type FinalizeJob, type TransactionInput } from './shared/types';
import type { Env } from './platform/env';
import { DASHBOARD_HTML } from './platform/dashboard';

// DO class 必須可被 wrangler bundle 到達（class_name = "AccountDO" / "EventHubDO"）
export { AccountDO } from './platform/account-do';
export { EventHubDO } from './platform/event-hub-do';

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

    // GET /events — SSE 訂閱（Item 8）：路由到 EventHub DO（單一 hub 實例）。
    // EventSource 連線保持開啟；AccountDO 提交成功後 hub fan-out `data: <JSON>\n\n`。
    if (request.method === 'GET' && url.pathname === '/events') {
      const hub = env.EVENT_HUB.get(env.EVENT_HUB.idFromName('hub'));
      return hub.fetch(request);
    }

    // GET /dashboard — 單頁儀表板（Item 8，來源 batch-creator/dashboard.ts 移植）。
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // GET /metrics — 壓測對照（Item 9，H7 人類核可）：D1 對帳讀取，不觸 H2 金流計算、不觸 H4 db 層。
    //   batched.requests = COUNT(processed_transactions)
    //   batched.dbWrites = COUNT(DISTINCT applied_version)（每批次 version+1 = 一次 D1 寫入）
    //   naive.*          = 數學基準（naive.dbWrites = naive.requests → ratio = 1）
    // 回應格式與來源 runner.ts 的 Metrics 介面一致：{ batched, naive }（見 scripts/load-generator.ts）。
    if (request.method === 'GET' && url.pathname === '/metrics') {
      const row = await env.DB.prepare(
        'SELECT COUNT(*) AS requests, COUNT(DISTINCT applied_version) AS dbWrites FROM processed_transactions',
      ).first<{ requests: number; dbWrites: number }>();
      const requests = row?.requests ?? 0;
      const dbWrites = row?.dbWrites ?? 0;
      return Response.json({
        batched: { requests, dbWrites },
        naive: { requests, dbWrites: requests },
      });
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
