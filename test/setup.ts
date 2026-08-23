// vitest setup：每個 test file（isolated storage）套用 D1 migrations。
// 用 ?raw 直接讀 .sql（單一來源，與 wrangler d1 migrations 共用同一檔案），
// 避免 import 主 plugin 模組（其為 Node 端 pool 程式碼，workerd 內載入會缺 node:os）。
import { applyD1Migrations, env } from 'cloudflare:test';
import migrationSql from '../migrations/0001_init.sql?raw';

const queries = migrationSql
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

await applyD1Migrations((env as unknown as { DB: D1Database }).DB, [
  { name: '0001_init', queries },
]);
