// EventHub Durable Object —— 領域事件廣播 hub（Item 8，H7 人類核可）。
//
// 取代來源 Redis pub/sub（EVENTS_CHANNEL）的廣播角色：
//   - SSE 客戶端 GET /events → 訂閱本 hub（回 text/event-stream，事件到達即 fan-out）；
//   - AccountDO commit 成功後 POST /publish → hub 把事件寫給所有已連線客戶端
//     （`data: <JSON>\n\n`，與來源 EVENTS_CHANNEL payload 一致）。
//
// 設計要點：
//   - 單一 hub 實例：`idFromName('hub')`（來源是單一 Redis channel，無需分片）。
//   - 客戶端集合存於記憶體：SSE 連線是長連線，DO 不會 hibernation 到失去此狀態
//     （有活躍 request 時 DO 保持載入）；事件廣播純觀測，斷線即遺失（與來源 SSE
//     客戶端斷線語意一致，EventSource 自動重連）。
//   - 發布失敗不影響主流程：AccountDO 側 catch（與來源 emitEvent non-blocking 一致）。
import { DurableObject } from 'cloudflare:workers';
import type { DomainEvent } from '../shared/types';
import type { Env } from './env';
import { formatSseData } from '../shared/events';

interface PublishRequest {
  type: 'publish';
  event: DomainEvent;
}

const encoder = new TextEncoder();

export class EventHubDO extends DurableObject<Env> {
  /** 已訂閱的 SSE 客戶端（Response stream 的 writer）。 */
  private clients = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /publish：接收領域事件並 fan-out 給所有 SSE 客戶端（來源 EVENTS_CHANNEL 語意）
    if (request.method === 'POST' && url.pathname === '/publish') {
      const req = (await request.json()) as PublishRequest;
      const payload = formatSseData(req.event);
      const bytes = encoder.encode(payload);
      for (const writer of this.clients) {
        try {
          await writer.write(bytes);
        } catch {
          // 單一客戶端斷線（EPIPE / write-after-end）不影響其他客戶端
          this.clients.delete(writer);
        }
      }
      return Response.json({ ok: true, clients: this.clients.size });
    }

    // GET：SSE 訂閱（text/event-stream；連線保持開啟直到客戶端關閉）
    if (request.method === 'GET') {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const writer = new WritableStream<Uint8Array>({
            write: (chunk) => controller.enqueue(chunk),
            close: () => controller.close(),
            abort: () => controller.error(new Error('client aborted')),
          }).getWriter();
          this.clients.add(writer);
          // 客戶端斷線 → 移除 writer（EventSource 會自動重連）
          request.signal.addEventListener('abort', () => {
            this.clients.delete(writer);
          });
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        },
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}
