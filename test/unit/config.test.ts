import { describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/shared/config';

// 移植自 uber_payment_poc（commit 739d9af）——依 Cloudflare Worker 環境調整：
// 以 env bindings 物件取代 global process.env；移除節點專屬的 port / DB 欄位。

const baseEnv = (): Record<string, unknown> => ({ SERVICE_NAME: 'svc', AZ_ID: 'az-1' });

describe('loadConfig', () => {
  it('在沒有環境變數時回傳預設值', () => {
    const cfg = loadConfig({});
    expect(cfg.serviceName).toBe('unknown');
    expect(cfg.azId).toBe('az-local');
    expect(cfg.logLevel).toBe('info');
  });

  it('讀取環境變數覆寫（serviceName / azId / logLevel）', () => {
    const cfg = loadConfig({ ...baseEnv(), LOG_LEVEL: 'debug' });
    expect(cfg).toEqual({ serviceName: 'svc', azId: 'az-1', logLevel: 'debug' } satisfies Config);
  });

  it('空字串視同未設定並回退預設值', () => {
    const cfg = loadConfig({ SERVICE_NAME: '', AZ_ID: '', LOG_LEVEL: '' });
    expect(cfg.serviceName).toBe('unknown');
    expect(cfg.azId).toBe('az-local');
    expect(cfg.logLevel).toBe('info');
  });

  it('非字串環境值（undefined / null / 數字）安全回退預設值', () => {
    const cfg = loadConfig({ SERVICE_NAME: undefined, AZ_ID: null, LOG_LEVEL: 3 });
    expect(cfg.serviceName).toBe('unknown');
    expect(cfg.azId).toBe('az-local');
    expect(cfg.logLevel).toBe('info');
  });

  it('無參數呼叫時回傳預設值（不 throw）', () => {
    const cfg = loadConfig();
    expect(cfg.serviceName).toBe('unknown');
  });
});
