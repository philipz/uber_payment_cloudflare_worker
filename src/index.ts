/**
 * uber_payment_cloudflare_worker — Cloudflare Worker 入口（placeholder 骨架）。
 *
 * Factory Item 1：僅建立可啟動的最小入口與測試基礎設施，**未實作任何業務邏輯**。
 * 後續工作項（operations / microuac / 金流核心）會於此掛載真實路由與 handler。
 */

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("OK", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
