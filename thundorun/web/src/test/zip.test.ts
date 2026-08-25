/**
 * zip — 직접 구현한 store 포맷이 **실제로 열리는 zip** 인지 바이트 수준으로 검증한다.
 * 파서(다른 코드)를 믿는 게 아니라 스펙 상수(PK 시그니처·CRC 알려진 벡터)에 대조한다.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, crc32 } from '@/server/zip';

const enc = new TextEncoder();
const u32at = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

describe('crc32', () => {
  it('알려진 벡터와 일치한다 — "123456789" → 0xCBF43926 (IEEE 표준 검증값)', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  it('빈 입력은 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('makeZip', () => {
  const entries = [
    { name: '01.jpg', data: enc.encode('first-image-bytes') },
    { name: '02.jpg', data: enc.encode('second') },
  ];
  const zip = makeZip(entries, new Date(2026, 7, 24, 12, 0, 0));

  it('로컬 헤더 시그니처로 시작한다 (PK\\x03\\x04)', () => {
    expect(u32at(zip, 0)).toBe(0x04034b50);
  });

  it('EOCD 로 끝나고 엔트리 수가 맞다 (PK\\x05\\x06)', () => {
    const eocd = zip.length - 22;                      // 코멘트 없음 → EOCD 는 정확히 22바이트
    expect(u32at(zip, eocd)).toBe(0x06054b50);
    expect(zip[eocd + 10] | (zip[eocd + 11] << 8)).toBe(2);  // total entries
  });

  it('중앙 디렉토리에 파일명이 순서대로 있다', () => {
    const bytes = Buffer.from(zip);
    const i1 = bytes.indexOf('01.jpg', 0, 'ascii');
    const i2 = bytes.indexOf('02.jpg', 0, 'ascii');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
  });

  it('로컬 헤더의 CRC 가 데이터와 일치한다', () => {
    // 첫 로컬 헤더: 오프셋 14 가 CRC 필드
    expect(u32at(zip, 14)).toBe(crc32(entries[0].data));
  });

  it('🔴 시스템 unzip 이 실제로 검증에 성공한다 (있는 환경에서만)', () => {
    let unzipPath = '';
    try { unzipPath = execFileSync('which', ['unzip']).toString().trim(); } catch { /* unzip 없음 */ }
    if (!unzipPath) return;                            // 도구 없는 박스에서는 건너뛴다(위 바이트 검증이 본선)
    const dir = mkdtempSync(join(tmpdir(), 'ziptest-'));
    try {
      const f = join(dir, 't.zip');
      writeFileSync(f, Buffer.from(zip));
      const out = execFileSync(unzipPath, ['-t', f]).toString();  // -t = 무결성 검사(CRC 대조)
      expect(out).toContain('No errors detected');
      expect(out).toContain('01.jpg');
      expect(out).toContain('02.jpg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
