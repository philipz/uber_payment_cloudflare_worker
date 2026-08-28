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
// Issue #60：擴充負 bigint、custom reserved、sliced buffer 的 byteOffset。

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

describe('MicroUAC 邊界條件（Issue #60）', () => {
  const MD5_16 = new Uint8Array([
    0x35, 0x63, 0x32, 0x35, 0x65, 0x62, 0x39, 0x38,
    0x64, 0x32, 0x31, 0x30, 0x61, 0x37, 0x66, 0x63,
  ]);

  it('負 bigint transactionId round-trip', () => {
    const uac: MicroUAC = {
      transactionId: -9876543210n,
      operationType: 0x01,
      amount: 100n,
      sequenceNumber: 1,
      accountVersion: 1,
      referenceHash: MD5_16,
      businessTime: 1700000000,
    };
    const decoded = unpackMicroUAC(packMicroUAC(uac));
    expect(decoded.transactionId).toBe(-9876543210n);
  });

  it('負 bigint amount round-trip', () => {
    const uac: MicroUAC = {
      transactionId: 123n,
      operationType: 0x02,
      amount: -5000n,
      sequenceNumber: 1,
      accountVersion: 1,
      referenceHash: MD5_16,
      businessTime: 1700000000,
    };
    const decoded = unpackMicroUAC(packMicroUAC(uac));
    expect(decoded.amount).toBe(-5000n);
  });

  it('custom reserved 欄位 round-trip', () => {
    const customReserved = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    const uac: MicroUAC = {
      transactionId: 1n,
      operationType: 0x01,
      amount: 1n,
      sequenceNumber: 1,
      accountVersion: 1,
      referenceHash: MD5_16,
      businessTime: 1700000000,
      reserved: customReserved,
    };
    const decoded = unpackMicroUAC(packMicroUAC(uac));
    expect([...decoded.reserved!]).toEqual([...customReserved]);
  });

  it('sliced buffer 的 byteOffset 正確處理', () => {
    const uac: MicroUAC = {
      transactionId: 999n,
      operationType: 0x01,
      amount: 500n,
      sequenceNumber: 5,
      accountVersion: 10,
      referenceHash: MD5_16,
      businessTime: 1700000000,
    };
    const packed = packMicroUAC(uac);

    // 建立一個有 offset 的 Uint8Array（模擬從更大 buffer 切出）
    const bigBuffer = new Uint8Array(100);
    bigBuffer.set(packed, 20); // 將 packed 放在 offset 20
    const sliced = bigBuffer.subarray(20, 20 + MICRO_UAC_SIZE);

    // sliced 有 byteOffset，解碼應正確處理
    expect(sliced.byteOffset).toBe(20);
    const decoded = unpackMicroUAC(sliced);
    expect(decoded.transactionId).toBe(999n);
    expect(decoded.amount).toBe(500n);
    expect(decoded.sequenceNumber).toBe(5);
    expect(decoded.accountVersion).toBe(10);
  });

  it('最大 bigint 值（64-bit signed）round-trip', () => {
    const maxInt64 = 9223372036854775807n; // 2^63 - 1
    const uac: MicroUAC = {
      transactionId: maxInt64,
      operationType: 0x01,
      amount: maxInt64,
      sequenceNumber: 65535, // max UInt16
      accountVersion: 4294967295, // max UInt32
      referenceHash: MD5_16,
      businessTime: 4294967295, // max UInt32
    };
    const decoded = unpackMicroUAC(packMicroUAC(uac));
    expect(decoded.transactionId).toBe(maxInt64);
    expect(decoded.amount).toBe(maxInt64);
    expect(decoded.sequenceNumber).toBe(65535);
    expect(decoded.accountVersion).toBe(4294967295);
    expect(decoded.businessTime).toBe(4294967295);
  });
});
