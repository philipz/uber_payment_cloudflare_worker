// microUacFor —— 移植自 uber_payment_poc src/services/batch-process/index.ts microUacFor（L48-57）。
// 語意（Q11a 位元組相容）：
//   transactionId MD5 前 8 bytes → 以 big-endian 收斂為 Int64（transactionId 欄位）
//   referenceId MD5 → 16-byte ReferenceHash
//   其餘欄位由呼叫方提供（amount/seq/accountVersion/businessTime/operationType）
import { packMicroUAC, type MicroUAC } from '../shared/microuac';
import { md5 } from './md5';

const INT64_BE = new DataView(new ArrayBuffer(8));

export function microUacFor(input: {
  transactionId: string;
  referenceId?: string;
  operationType: number;
  amount: number;
  sequenceNumber: number;
  accountVersion: number;
  businessTime: number;
}): Uint8Array {
  const txHash = md5(input.transactionId);
  // 前 8 bytes big-endian 收斂為 Int64（與來源 readBigInt64BE(0) 相同）
  INT64_BE.setUint8(0, txHash[0]);
  INT64_BE.setUint8(1, txHash[1]);
  INT64_BE.setUint8(2, txHash[2]);
  INT64_BE.setUint8(3, txHash[3]);
  INT64_BE.setUint8(4, txHash[4]);
  INT64_BE.setUint8(5, txHash[5]);
  INT64_BE.setUint8(6, txHash[6]);
  INT64_BE.setUint8(7, txHash[7]);

  const referenceHash = input.referenceId
    ? md5(input.referenceId)
    : md5(input.transactionId);

  const uac: MicroUAC = {
    transactionId: INT64_BE.getBigInt64(0),
    operationType: input.operationType,
    amount: BigInt(input.amount),
    sequenceNumber: input.sequenceNumber,
    accountVersion: input.accountVersion,
    referenceHash,
    businessTime: input.businessTime,
  };
  return packMicroUAC(uac);
}
