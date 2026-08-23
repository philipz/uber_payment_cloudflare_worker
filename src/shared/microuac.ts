// MicroUAC：48-byte 緊湊審計記錄的二進位編解碼（big-endian）。
// 移植自 uber_payment_poc（commit 739d9af）——佈局/欄位/位元組序完全一致（位元組相容，
// Q11a），僅把 Node Buffer 改為 Uint8Array + DataView（Workers 無原生 Buffer）。
// 欄位佈局（offset / size）：
//   0  TransactionID   Int64   (8)
//   8  OperationType   UInt8   (1)
//   9  Amount          Int64   (8)
//   17 SequenceNumber  UInt16  (2)
//   19 AccountVersion  UInt32  (4)
//   23 ReferenceHash   Binary  (16)
//   39 BusinessTime    UInt32  (4)
//   43 ReservedBytes   Binary  (5)
//   ────────────────────────── 共 48 bytes

export const MICRO_UAC_SIZE = 48;
const REFERENCE_HASH_SIZE = 16;
const RESERVED_SIZE = 5;

export interface MicroUAC {
  transactionId: bigint; // Int64
  operationType: number; // UInt8
  amount: bigint; // Int64（最小貨幣單位）
  sequenceNumber: number; // UInt16，批次內順序
  accountVersion: number; // UInt32，此變更提交後的賬戶版本
  referenceHash: Uint8Array; // 16 bytes（業務單據 MD5，Q11a 保留收斂）
  businessTime: number; // UInt32，Unix 秒
  reserved?: Uint8Array; // 5 bytes，預設全 0
}

export function packMicroUAC(u: MicroUAC): Uint8Array {
  if (u.referenceHash.length !== REFERENCE_HASH_SIZE) {
    throw new Error(`referenceHash must be ${REFERENCE_HASH_SIZE} bytes`);
  }
  const out = new Uint8Array(MICRO_UAC_SIZE);
  const view = new DataView(out.buffer);
  view.setBigInt64(0, u.transactionId); // big-endian 為預設
  view.setUint8(8, u.operationType);
  view.setBigInt64(9, u.amount);
  view.setUint16(17, u.sequenceNumber);
  view.setUint32(19, u.accountVersion);
  out.set(u.referenceHash, 23);
  view.setUint32(39, u.businessTime);
  if (u.reserved) out.set(u.reserved, 43);
  return out;
}

export function unpackMicroUAC(buf: Uint8Array): MicroUAC {
  if (buf.length !== MICRO_UAC_SIZE) {
    throw new Error(`MicroUAC buffer must be ${MICRO_UAC_SIZE} bytes, got ${buf.length}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    transactionId: view.getBigInt64(0),
    operationType: view.getUint8(8),
    amount: view.getBigInt64(9),
    sequenceNumber: view.getUint16(17),
    accountVersion: view.getUint32(19),
    referenceHash: buf.slice(23, 39),
    businessTime: view.getUint32(39),
    reserved: buf.slice(43, 48),
  };
}
