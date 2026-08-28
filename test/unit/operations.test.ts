import { describe, expect, it } from 'vitest';
import { applyOperation, dedupeTransactions, replayBatch } from '../../src/shared/operations';
import { OperationType, type TransactionInput } from '../../src/shared/types';

// 移植自 uber_payment_poc（commit 739d9af）——斷言與來源完全一致，作為語意契約。
// Issue #60：擴充零金額、負起始餘額、alreadyProcessed 與批次內重複交錯。

const tx = (id: string): TransactionInput => ({
  transactionId: id,
  operationType: OperationType.Credit,
  amount: 1,
});

describe('applyOperation', () => {
  it('Credit 增加餘額', () => {
    expect(applyOperation(100, OperationType.Credit, 50)).toBe(150);
  });

  it('Debit 減少餘額', () => {
    expect(applyOperation(100, OperationType.Debit, 30)).toBe(70);
  });

  it('Authorize 視為保留扣減', () => {
    expect(applyOperation(100, OperationType.Authorize, 40)).toBe(60);
  });

  it('Release 視為回補', () => {
    expect(applyOperation(100, OperationType.Release, 40)).toBe(140);
  });

  it('未知操作丟出例外', () => {
    expect(() => applyOperation(100, 0x99 as OperationType, 1)).toThrow();
  });
});

describe('applyOperation 邊界條件（Issue #60）', () => {
  it('零金額 Credit 保持餘額不變', () => {
    expect(applyOperation(100, OperationType.Credit, 0)).toBe(100);
  });

  it('零金額 Debit 保持餘額不變', () => {
    expect(applyOperation(100, OperationType.Debit, 0)).toBe(100);
  });

  it('負起始餘額 Credit', () => {
    expect(applyOperation(-50, OperationType.Credit, 100)).toBe(50);
  });

  it('負起始餘額 Debit（可能更負）', () => {
    expect(applyOperation(-50, OperationType.Debit, 30)).toBe(-80);
  });

  it('大金額計算（JS Number 安全整數範圍）', () => {
    const big = Number.MAX_SAFE_INTEGER - 100;
    expect(applyOperation(big, OperationType.Credit, 50)).toBe(big + 50);
  });
});

describe('replayBatch', () => {
  it('依序重放並回傳每筆後餘額與最終餘額', () => {
    const txns: TransactionInput[] = [
      { transactionId: 'a', operationType: OperationType.Credit, amount: 100 },
      { transactionId: 'b', operationType: OperationType.Debit, amount: 30 },
      { transactionId: 'c', operationType: OperationType.Credit, amount: 5 },
    ];
    const { newBalance, steps } = replayBatch(1000, txns);
    expect(newBalance).toBe(1075);
    expect(steps).toEqual([
      { transactionId: 'a', balanceAfter: 1100 },
      { transactionId: 'b', balanceAfter: 1070 },
      { transactionId: 'c', balanceAfter: 1075 },
    ]);
  });

  it('空批次回原餘額', () => {
    expect(replayBatch(500, [])).toEqual({ newBalance: 500, steps: [] });
  });
});

describe('replayBatch 邊界條件（Issue #60）', () => {
  it('負起始餘額批次', () => {
    const txns: TransactionInput[] = [
      { transactionId: 'x', operationType: OperationType.Credit, amount: 100 },
    ];
    const { newBalance, steps } = replayBatch(-200, txns);
    expect(newBalance).toBe(-100);
    expect(steps).toEqual([{ transactionId: 'x', balanceAfter: -100 }]);
  });

  it('全部零金額批次', () => {
    const txns: TransactionInput[] = [
      { transactionId: 'z1', operationType: OperationType.Credit, amount: 0 },
      { transactionId: 'z2', operationType: OperationType.Debit, amount: 0 },
    ];
    const { newBalance, steps } = replayBatch(50, txns);
    expect(newBalance).toBe(50);
    expect(steps).toEqual([
      { transactionId: 'z1', balanceAfter: 50 },
      { transactionId: 'z2', balanceAfter: 50 },
    ]);
  });
});

describe('dedupeTransactions', () => {
  it('排除批次內重複的 transactionId（保留首次）', () => {
    const out = dedupeTransactions([tx('a'), tx('b'), tx('a')], new Set());
    expect(out.map((t) => t.transactionId)).toEqual(['a', 'b']);
  });

  it('排除已套用的 transactionId', () => {
    const out = dedupeTransactions([tx('a'), tx('b')], new Set(['a']));
    expect(out.map((t) => t.transactionId)).toEqual(['b']);
  });

  it('全部重複時回空陣列', () => {
    expect(dedupeTransactions([tx('a'), tx('a')], new Set(['a']))).toEqual([]);
  });
});

describe('dedupeTransactions 邊界條件（Issue #60）', () => {
  it('alreadyProcessed 與批次內重複交錯', () => {
    // 批次：a, b, c, a, b, d
    // alreadyProcessed: b, c
    // 預期結果：a, d（a 首次出現保留；b, c 已處理排除；第二個 a 批次內重複排除；d 首次保留）
    const txns = [tx('a'), tx('b'), tx('c'), tx('a'), tx('b'), tx('d')];
    const processed = new Set(['b', 'c']);
    const out = dedupeTransactions(txns, processed);
    expect(out.map((t) => t.transactionId)).toEqual(['a', 'd']);
  });

  it('空 alreadyProcessed 僅處理批次內重複', () => {
    const txns = [tx('x'), tx('y'), tx('x'), tx('z'), tx('y')];
    const out = dedupeTransactions(txns, new Set());
    expect(out.map((t) => t.transactionId)).toEqual(['x', 'y', 'z']);
  });

  it('批次為空回空陣列', () => {
    expect(dedupeTransactions([], new Set(['a', 'b']))).toEqual([]);
  });
});
