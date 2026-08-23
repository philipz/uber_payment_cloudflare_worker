import { describe, expect, it } from 'vitest';
import {
  MICRO_UAC_SIZE,
  packMicroUAC,
  unpackMicroUAC,
  type MicroUAC,
} from '../../src/shared/microuac';

// 移植自 uber_payment_poc（commit 739d9af）——斷言與來源一致；
// 差異：workerd 無 node:crypto，referenceHash 改為固定 16-byte 陣列（本測試不測 MD5 本身）。
// operationType 以數值字面量（OperationType.Debit = 0x02）避免相依於 types.ts，保持本模組獨立。

// 固定 16 bytes（等效來源的 createHash('md5').update('order-abc').digest()）
const MD5_16 = new Uint8Array([
  0x35, 0x63, 0x32, 0x35, 0x65, 0x62, 0x39, 0x38,
  0x64, 0x32, 0x31, 0x30, 0x61, 0x37, 0x66, 0x63,
]);

describe('MicroUAC pack/unpack', () => {
  const sample: MicroUAC = {
    transactionId: 1234567890123n,
    operationType: 0x02, // OperationType.Debit
    amount: 99999n,
    sequenceNumber: 7,
    accountVersion: 42,
    referenceHash: MD5_16,
    businessTime: 1782000000,
  };

  it('打包長度恰為 48 bytes', () => {
    expect(packMicroUAC(sample).length).toBe(MICRO_UAC_SIZE);
  });

  it('round-trip 後各欄位一致', () => {
    const decoded = unpackMicroUAC(packMicroUAC(sample));
    expect(decoded.transactionId).toBe(sample.transactionId);
    expect(decoded.operationType).toBe(sample.operationType);
    expect(decoded.amount).toBe(sample.amount);
    expect(decoded.sequenceNumber).toBe(sample.sequenceNumber);
    expect(decoded.accountVersion).toBe(sample.accountVersion);
    expect([...decoded.referenceHash]).toEqual([...sample.referenceHash]);
    expect(decoded.businessTime).toBe(sample.businessTime);
    expect(decoded.reserved?.length).toBe(5);
  });

  it('referenceHash 非 16 bytes 應丟錯', () => {
    expect(() => packMicroUAC({ ...sample, referenceHash: new Uint8Array(8) })).toThrow();
  });

  it('錯誤長度的 buffer 解碼應丟錯', () => {
    expect(() => unpackMicroUAC(new Uint8Array(40))).toThrow();
  });
});
