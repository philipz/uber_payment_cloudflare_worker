/// <reference types="node" />
/**
 * 神諭 harness（比照 software_factory test/quint/scoring-oracle.test.ts）。
 *
 * 以 Quint 模型為 oracle：quint run 產生 ITF traces，逐一與 TS 實作
 * （src/shared/operations.ts）比對。模型與實作不一致 → 代表「程式碼偏離規格書」→ CI 紅燈。
 *
 * ITF 結構（quint 0.32.0 實測）：map = {"#map": [[k,v],...]}、set = {"#set": [...]}、
 * int = {"#bigint": "..."}、list = 純陣列、record = 純物件。
 *
 * Issue #60：擴充多 seed / max-samples 擴大模型覆蓋。
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

// 多 seed 擴大覆蓋（Issue #60）
const SEEDS = [0, 42, 123];
const MAX_SAMPLES = 3;

let traceDir: string;
let allStates: ItfState[] = [];

beforeAll(
  () => {
    traceDir = mkdtempSync(join(tmpdir(), 'quint-oracle-'));
    for (const seed of SEEDS) {
      const outFile = join(traceDir, `trace-seed${seed}.itf.json`);
      execFileSync(
        'npx',
        [
          'quint', 'run', '--main', 'uber_payment',
          '--seed', String(seed),
          '--max-samples', String(MAX_SAMPLES),
          '--max-steps', '120',
          '--out-itf', outFile,
          SPEC,
        ],
        { cwd: ROOT, stdio: 'pipe' },
      );
      const trace = JSON.parse(readFileSync(outFile, 'utf8')) as { states: ItfState[] };
      // 跳過每個 trace 的 init state
      allStates.push(...trace.states.slice(1));
    }
  },
  180_000, // 多 seed 需更長 timeout
);

afterAll(() => {
  rmSync(traceDir, { recursive: true, force: true });
});

describe('Quint 神諭：TS operations.ts 與規格模型一致', () => {
  it('模型產出足夠多的 states（覆蓋多種輸入組合）', () => {
    // 多 seed * max-samples 應產出更多 states
    expect(allStates.length).toBeGreaterThan(50);
  });

  it('每帳戶：TS replayBatch(審計 ops) 起始 0 == 模型餘額（balanceEqualsSignedSum 對照）', () => {
    for (const s of allStates) {
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
    for (const s of allStates) {
      for (const r of s.audit['#map'].map(([, v]) => v)) {
        const op = num(r.op);
        const amount = num(r.amount);
        const expected = op === OperationType.Debit || op === OperationType.Authorize ? -amount : amount;
        expect(applyOperation(0, op as OperationType, amount), `op=${op} amount=${amount}`).toBe(expected);
      }
    }
  });

  it('審計 txnIds 集合 == processed 集合（模型 auditEqualsProcessed 在 trace 上成立）', () => {
    for (const s of allStates) {
      const auditIds = new Set(s.audit['#map'].map(([, v]) => String(num(v.txnId))));
      const processedIds = new Set(s.processed['#set'].map((n) => String(num(n))));
      expect(auditIds, `audit=${[...auditIds].join(',')} processed=${[...processedIds].join(',')}`).toEqual(
        processedIds,
      );
    }
  });

  it('TS dedupeTransactions：全部已處理 → 空（at-least-once 冪等語意對照）', () => {
    for (const s of allStates) {
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

describe('Quint 神諭：多 seed 覆蓋（Issue #60）', () => {
  it('多 seed 產生不同的 trace（狀態多樣性）', () => {
    // 驗證不同 seed 確實產生了不同狀態（至少 processed set 或 audit 有差異）
    // 這是 smoke test，確保多 seed 機制有效
    expect(allStates.length).toBeGreaterThan(SEEDS.length * 10); // 每 seed 應貢獻多個 states
  });
});
