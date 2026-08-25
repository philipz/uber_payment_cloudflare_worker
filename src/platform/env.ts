// Env bindings（Item 6 + Item 8）。wrangler types 可用於生成，此處手動宣告保持一致。
import type { FinalizeJob } from '../shared/types';

export interface Env {
  DB: D1Database;
  ACCOUNT_DO: DurableObjectNamespace;
  FINALIZE_QUEUE: Queue<FinalizeJob>;
  // Item 8：領域事件廣播 hub（取代來源 Redis pub/sub EVENTS_CHANNEL）
  EVENT_HUB: DurableObjectNamespace;
}
