// Redis / 佇列 / 計量的 key 命名常數與小工具（移植自 uber_payment_poc，commit 739d9af；
// Factory Item 4 移植）。供 batch-creator（→ Worker routes）與 batch-process（→ 金流核心）
// 共用以保持一致命名。平台無關（純字串常數，無 node / 平台依賴）。

// 全域任務佇列（Phase 2 起：一個 batch 一個任務）
export const GLOBAL_QUEUE = 'tasks:global';

// 時間窗口長度（毫秒）
export const WINDOW_MS = 250;

// 下游 finalize 通知佇列：審計已在主交易內原子落庫，此佇列僅供 post-process 做下游傳播
// （Kafka stub + Finalized 事件）。通知遺失不影響審計（審計已持久化）。
export const FINALIZE_QUEUE = 'finalize:queue';

// 領域事件廣播頻道（Redis pub/sub）：各服務發布狀態機事件，creator 訂閱後轉發給 SSE 客戶端
export const EVENTS_CHANNEL = 'events';

// 對照組計量：每模式的請求數與 DB 寫入數，用於壓縮比展示
export const requestsKey = (mode: string): string => `metrics:requests:${mode}`;
export const dbWritesKey = (mode: string): string => `metrics:dbwrites:${mode}`;

// 可靠佇列（at-least-once）：worker 以 BLMOVE 把任務移入自己的 processing list，成功後 LREM 確認；
// 心跳逾時即視為死亡，由其他 worker 把其 processing list 的任務搬回全域佇列重認領。
export const WORKERS_SET = 'workers'; // 所有 worker id 集合
export const processingKey = (workerId: string): string => `processing:${workerId}`;
export const aliveKey = (workerId: string): string => `worker:alive:${workerId}`;

// 結果快取：worker 寫入、creator 輪詢
export const resultKey = (taskId: string): string => `result:${taskId}`;
