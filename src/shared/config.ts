// 各服務共用的環境設定（移植自 uber_payment_poc，commit 739d9af；Factory Item 4 移植）。
//
// 依 Cloudflare Worker 環境調整（原 PoC 為 node:http 服務）：
//   - 以「env bindings 物件」取代 global `process.env`（Worker 讀取 env 的慣例），
//     保持平台無關、可注入測試。
//   - 移除節點專屬欄位（`port` / `redisUrl` / `databaseUrl`）：Worker 由 fetch 入口服務、
//     外部儲存走平台 binding（D1/KV/Queues，屬 Item 6 範圍），此層不引入 binding 讀取邏輯。
//   - 保留來源的 `serviceName` / `azId` 欄位與「缺省回退」語意；額外提供 `logLevel`
//     （對應 .dev.vars.example 的 LOG_LEVEL）。此層不含任何機密欄位。

export interface Config {
  serviceName: string;
  azId: string;
  logLevel: string;
}

// Worker env bindings 的窄子集：此模組只讀取與自身有關的字串欄位。
export type EnvBindings = Record<string, unknown>;

const DEFAULTS: Readonly<Config> = {
  serviceName: 'unknown',
  azId: 'az-local',
  logLevel: 'info',
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function loadConfig(env: EnvBindings = {}): Config {
  return {
    serviceName: str(env.SERVICE_NAME) ?? DEFAULTS.serviceName,
    azId: str(env.AZ_ID) ?? DEFAULTS.azId,
    logLevel: str(env.LOG_LEVEL) ?? DEFAULTS.logLevel,
  };
}
