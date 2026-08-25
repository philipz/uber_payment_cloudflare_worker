// post-process 全功能（Item 10，H2 人類裁決）。
//
// 來源 uber_payment_poc post-process/index.ts：審計已由 batch-process 在主交易內
// 原子落庫，post-process 只做下游傳播——Kafka stub log + Finalized 領域事件發布。
// 此處把「單筆 FinalizeJob 的處理」抽成純邏輯（publish 可注入），queue handler
// 只做薄包裝——可獨立單元測試（不依賴跨 isolate 的 queue 投遞）。
import { TxnState, type DomainEvent, type FinalizeJob } from '../shared/types';

export interface FinalizePublish {
  (event: DomainEvent): Promise<void>;
}

/**
 * 處理一筆 FinalizeJob：Kafka stub log + Finalized 事件發布。
 * publish 可注入（測試傳 fake；正式由 queue handler 注入 publishEvent）。
 * 與來源 emitEvent 同語意：發布失敗不影響主流程（呼叫方自行 catch 或此處吞）。
 */
export async function handleFinalizeJob(
  job: FinalizeJob,
  publish: FinalizePublish,
): Promise<void> {
  // Kafka stub：以 stdout 模擬向下游發布變更事件（來源 post-process publish() 語意）
  console.log(`[finalize] kafka(stub) 發布變更事件 account=${job.accountId} records=${job.count}`);
  await publish({
    ts: Date.now(),
    state: TxnState.Finalized,
    accountId: job.accountId,
    batchId: job.batchId,
    size: job.count,
  });
}
