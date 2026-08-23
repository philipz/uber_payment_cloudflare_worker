import { describe, expect, it, vi } from 'vitest';
import { emitEventLog, formatEventLog } from '../../src/shared/events';
import { TxnState, type DomainEvent } from '../../src/shared/types';

// 移植自 uber_payment_poc（commit 739d9af）的 emitEvent 之 log 部分——log 行格式與
// 來源 console.log 輸出逐一對應（僅移植 log，不引入 Redis / ioredis 依賴）。

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  ts: 1000,
  state: TxnState.Committed,
  accountId: 'acct-1',
  ...over,
});

describe('formatEventLog', () => {
  it.skip('最小事件只輸出 state 與 account，且不含尾隨空白', () => {
    expect(formatEventLog(event())).toBe('[event] Committed account=acct-1');
  });

  it.skip('交易事件輸出 txn 欄位', () => {
    expect(formatEventLog(event({ state: TxnState.Ingested, transactionId: 'tx1' }))).toBe(
      '[event] Ingested account=acct-1 txn=tx1',
    );
  });

  it.skip('批次事件輸出 batch 與 az 欄位', () => {
    expect(
      formatEventLog(
        event({ state: TxnState.Accumulating, accountId: 'a2', batchId: 'b9', az: 'az-2' }),
      ),
    ).toBe('[event] Accumulating account=a2 batch=b9 az=az-2');
  });

  it.skip('提交後輸出版本與餘額欄位', () => {
    expect(formatEventLog(event({ version: 3, balance: 1000 }))).toBe(
      '[event] Committed account=acct-1 ver=3 bal=1000',
    );
  });

  it.skip('空字串欄位不出現在 detail 中', () => {
    expect(formatEventLog(event({ transactionId: '', batchId: '' }))).toBe(
      '[event] Committed account=acct-1',
    );
  });
});

describe('emitEventLog', () => {
  it.skip('透過注入 logger 輸出格式化的事件行', () => {
    const logger = vi.fn();
    emitEventLog(event({ transactionId: 'tx1', version: 2 }), logger);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith('[event] Committed account=acct-1 txn=tx1 ver=2');
  });
});
