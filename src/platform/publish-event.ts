// publishEvent —— 發布領域事件到 EventHub DO（單一 hub 實例）。
//
// Item 8 建立 EventHub DO（取代來源 Redis pub/sub）後，發布端呼叫邏輯在
// AccountDO（Committed）與 queue consumer（Finalized，Item 10）重複——抽成共享
// 模組避免漂移。與來源 emitEvent 同語意：發布失敗 non-blocking（廣播遺失不影響
// 審計正確性）。
import type { DomainEvent } from '../shared/types';
import type { Env } from './env';

export async function publishEvent(env: Env, event: DomainEvent): Promise<void> {
  const hub = env.EVENT_HUB.get(env.EVENT_HUB.idFromName('hub'));
  await hub.fetch('https://hub/publish', {
    method: 'POST',
    body: JSON.stringify({ type: 'publish', event } satisfies { type: 'publish'; event: DomainEvent }),
  });
}
