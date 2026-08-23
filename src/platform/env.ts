// Env bindings（Item 6）。wrangler types 可用於生成，此處手動宣告保持一致。
import type { FinalizeJob } from '../shared/types';

export interface Env {
  DB: D1Database;
  ACCOUNT_DO: DurableObjectNamespace;
  FINALIZE_QUEUE: Queue<FinalizeJob>;
}
