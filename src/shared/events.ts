// 領域事件 log 契約（契約先行層，Factory Item 4 01-test）。詳細格式化/輸出
// 實作於 02-impl 層補齊後由測試驗證。

import type { DomainEvent } from './types';

export function formatEventLog(event: DomainEvent): string {
  return `[event] ${event.state}`;
}

export function emitEventLog(event: DomainEvent, logger: (line: string) => void = console.log): void {
  logger(formatEventLog(event));
}
