/// <reference types="node" />
/**
 * 神諭 harness（比照 software_factory test/quint/scoring-oracle.test.ts）。
 *
 * 以 Quint 模型為 oracle：quint run 產生 ITF traces，逐一與 TS 實作
 * （src/shared/operations.ts）比對。模型與實作不一致 → 代表「程式碼偏離規格書」→ CI 紅燈。
 *
 * ITF 結構（quint 0.32.0 實測）：map = {"#map": [[k,v],...]}、set = {"#set": [...]}、
 * int = {"#bigint": "..."}、list = 純陣列、record = 純物件。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOperation, dedupeTransactions, replayBatch } from '../../src/shared/operations';
import { OperationType, type TransactionInput } from '../../src/shared/types';

const ROOT = join(import.meta.dirname, '../..');
const SPEC = join(ROOT, 'specs/uber-payment.qnt');

type Num = { '#bigint'?: string } | number;

interface AuditRec {
  txnId: Num;
  accountId: Num;
  op: Num;
  amount: Num;
  version: Num;
  seq: Num;
  status: Num;
}
interface AccountState {
  balance: Num;
  version: Num;
}
interface ItfState {
  accounts: { '#map': [Num, AccountState][] };
  audit: { '#map': [Num, AuditRec][] };
  processed: { '#set': Num[] };
  openBatch: unknown;
}

function num(v: Num | undefined): number {
  if (typeof v === 'number') return v;
  if (v && typeof v['#bigint'] === 'string') return Number(v['#bigint']);
  return NaN;
}

let traceDir: string;
let states: ItfState[];

beforeAll(
  () => {
    traceDir = mkdtempSync(join(tmpdir(), 'quint-oracle-'));
    execFileSync(
      'npx',
      [
        'quint', 'run', '--main', 'uber_payment', '--seed', '0', '--max-samples', '1', '--max-steps', '120',
        '--out-itf', join(traceDir, 'trace.itf.json'),
        SPEC,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const trace = JSON.parse(readFileSync(join(traceDir, 'trace.itf.json'), 'utf8')) as {
      states: ItfState[];
    };
    // 跳過 init state
    states = trace.states.slice(1);
  },
  120_000,
);

afterAll(() => {
  rmSync(traceDir, { recursive: true, force: true });
});

describe('Quint 神諭：TS operations.ts 與規格模型一致', () => {
  it('模型產出足夠多的 states（覆蓋多種輸入組合）', () => {
    expect(states.length).toBeGreaterThan(50);
  });

  it('每帳戶：TS replayBatch(審計 ops) 起始 0 == 模型餘額（balanceEqualsSignedSum 對照）', () => {
    for (const s of states) {
      for (const [accKey, acc] of s.accounts['#map']) {
        const accId = num(accKey);
        const auditOps = s.audit['#map'].map(([, v]) => v).filter((r) => num(r.accountId) === accId);
        const txns: TransactionInput[] = auditOps.map((r) => ({
          transactionId: String(num(r.txnId)),
          operationType: num(r.op) as OperationType,
          amount: num(r.amount),
        }));
        const { newBalance } = replayBatch(0, txns);
        expect(newBalance, `acc=${accId} 審計筆數=${auditOps.length}`).toBe(num(acc.balance));
      }
    }
  });

  it('每筆審計：TS applyOperation(0) 帶符號 == 模型 signedAmount（op 1,4 → +；2,3 → −）', () => {
    for (const s of states) {
      for (const r of s.audit['#map'].map(([, v]) => v)) {
        const op = num(r.op);
        const amount = num(r.amount);
        const expected = op === OperationType.Debit || op === OperationType.Authorize ? -amount : amount;
        expect(applyOperation(0, op as OperationType, amount), `op=${op} amount=${amount}`).toBe(expected);
      }
    }
  });

  it('審計 txnIds 集合 == processed 集合（模型 auditEqualsProcessed 在 trace 上成立）', () => {
    for (const s of states) {
      const auditIds = new Set(s.audit['#map'].map(([, v]) => String(num(v.txnId))));
      const processedIds = new Set(s.processed['#set'].map((n) => String(num(n))));
      expect(auditIds, `audit=${[...auditIds].join(',')} processed=${[...processedIds].join(',')}`).toEqual(
        processedIds,
      );
    }
  });

  it('TS dedupeTransactions：全部已處理 → 空（at-least-once 冪等語意對照）', () => {
    for (const s of states) {
      const processedIds = new Set(s.processed['#set'].map((n) => String(num(n))));
      const txns: TransactionInput[] = s.audit['#map'].map(([, v]) => v).map((r) => ({
        transactionId: String(num(r.txnId)),
        operationType: num(r.op) as OperationType,
        amount: num(r.amount),
      }));
      // 模型語意：已提交交易的 pending 為空（重送被吸收）
      expect(dedupeTransactions(txns, processedIds)).toEqual([]);
    }
  });
});
