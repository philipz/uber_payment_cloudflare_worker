// 純 JS MD5 位元組相容驗證（RFC 1321 標準向量）——與 Node createHash('md5') 輸出一致，
// 是 MicroUAC 審計「位元組相容」（Q11a）的根基。
import { describe, expect, it } from 'vitest';
import { md5 } from '../../src/platform/md5';

function hex(u: Uint8Array): string {
  return [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('md5 (RFC 1321 vectors)', () => {
  it('空字串', () => {
    expect(hex(md5(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('abc', () => {
    expect(hex(md5('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('The quick brown fox jumps over the lazy dog', () => {
    expect(hex(md5('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('與 Uint8Array 輸入一致', () => {
    expect(hex(md5(new TextEncoder().encode('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
