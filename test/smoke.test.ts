import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * 骨架 smoke test：驗證 Worker 能建構/啟動，並對根路徑回傳 200 OK。
 * 這測試證明了「測試→實作→綠燈」的 factory 基礎設施可運作（Factory Item 1 DoD）。
 */
describe("worker smoke test", () => {
  it("boots and answers GET / with 200 OK", async () => {
    const response = await SELF.fetch("https://example.com/", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("returns 404 for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/nope", {
      method: "GET",
    });
    expect(response.status).toBe(404);
  });
});
