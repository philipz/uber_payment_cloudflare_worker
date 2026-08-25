// 領域事件的 log 部分（移植自 uber_payment_poc，commit 739d9af；Factory Item 4 移植）。
//
// 原 PoC 的 `emitEvent` 既寫 stdout log 也發布 Redis pub/sub（ioredis）。此處依
// Cloudflare Worker 環境調整，只移植「事件 log」這部分且平台無關（無 node:http /
// ioredis 依賴）：`formatEventLog` 為純函式建構 log 行，`emitEventLog` 透過注入的
// logger（預設 console.log）輸出。Redis 廣播屬平台 binding 語意，留在 Item 6 範圍，
// 本層不引入。
//
// 這是狀態機事件的「單一事實來源」log 格式：同一份事件在處理路徑各處轉為一致的可讀行。

import type { DomainEvent } from './types';

// 建構事件的單行 log 文字（與來源 emitEvent 的 console.log 格式逐一對應）。
export function formatEventLog(event: DomainEvent): string {
  const detail = [
    event.transactionId ? `txn=${event.transactionId}` : '',
    event.batchId ? `batch=${event.batchId}` : '',
    event.az ? `az=${event.az}` : '',
    event.version !== undefined ? `ver=${event.version}` : '',
    event.balance !== undefined ? `bal=${event.balance}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `[event] ${event.state} account=${event.accountId} ${detail}`.trimEnd();
}

// 輸出事件 log。logger 可注入以便測試側寫；預設寫到 console。
export function emitEventLog(event: DomainEvent, logger: (line: string) => void = console.log): void {
  logger(formatEventLog(event));
}

// SSE 資料行（Item 8，H7 人類核可）：`data: <JSON>\n\n`——與來源 emitEvent 發布到
// EVENTS_CHANNEL 的 payload（JSON.stringify(event)）一致；EventHub DO 以此 fan-out。
// 純函式，可獨立測試。
export function formatSseData(event: DomainEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
