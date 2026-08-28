// 純 JS MD5 位元組相容驗證（RFC 1321 標準向量）——與 Node createHash('md5') 輸出一致，
// 是 MicroUAC 審計「位元組相容」（Q11a）的根基。
// Issue #60：擴充 55/56/64 bytes padding 邊界、長輸入向量。
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

describe('md5 padding 邊界（Issue #60）', () => {
  // MD5 padding 規則：原訊息長度 mod 64 決定 padding 行為
  // 55 bytes: 剛好填滿第一個 block（55+1+8=64）
  // 56 bytes: 需要第二個 block（56+1+8=65 > 64）
  // 64 bytes: 一個完整 block，padding 到第二個 block

  it('55 bytes（剛好填滿單一 block）', () => {
    const input = 'a'.repeat(55);
    // 預期值由 Node crypto 計算：createHash('md5').update('a'.repeat(55)).digest('hex')
    expect(hex(md5(input))).toBe('ef1772b6dff9a122358552954ad0df65');
  });

  it('56 bytes（跨越到第二個 block）', () => {
    const input = 'a'.repeat(56);
    // 預期值由 Node crypto 計算
    expect(hex(md5(input))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });

  it('64 bytes（一個完整 block + padding block）', () => {
    const input = 'a'.repeat(64);
    // 預期值由 Node crypto 計算
    expect(hex(md5(input))).toBe('014842d480b571495a4a0363793f7367');
  });
});

describe('md5 長輸入向量（Issue #60）', () => {
  it('1000 bytes', () => {
    const input = 'x'.repeat(1000);
    // 預期值由 Node crypto 計算：createHash('md5').update('x'.repeat(1000)).digest('hex')
    expect(hex(md5(input))).toBe('398533d48111e9f664b1f64cb10c4b63');
  });

  it('10000 bytes', () => {
    const input = 'y'.repeat(10000);
    // 預期值由 Node crypto 計算：createHash('md5').update('y'.repeat(10000)).digest('hex')
    expect(hex(md5(input))).toBe('f95fd7316c5fd51bc4f518dde7ff2406');
  });

  it('混合 ASCII 與非 ASCII（UTF-8 多位元組）', () => {
    const input = '你好世界🎉';
    // 預期值由 Node crypto 計算：createHash('md5').update('你好世界🎉').digest('hex')
    expect(hex(md5(input))).toBe('701b6fa567a04655e0e97d4e40f634e4');
  });
});
