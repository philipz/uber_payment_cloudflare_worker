// 環境設定契約（契約先行層，Factory Item 4 01-test）。此層先定義「正確」的
// 型別與介面骨架，詳細解析實作於 02-impl 層補齊後由測試驗證。

export interface Config {
  serviceName: string;
  azId: string;
  logLevel: string;
}

export type EnvBindings = Record<string, unknown>;

const DEFAULTS: Readonly<Config> = {
  serviceName: 'unknown',
  azId: 'az-local',
  logLevel: 'info',
};

export function loadConfig(_env: EnvBindings = {}): Config {
  return { ...DEFAULTS };
}
