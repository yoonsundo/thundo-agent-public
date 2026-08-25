/**
 * server/zip.ts — 의존성 없는 최소 ZIP 생성기 (무압축 store)
 *
 * 왜 직접 만드나: 카드뉴스 슬라이드 7장(~120KB JPEG)을 관리자에게 **파일 하나로** 주기 위해서다.
 * 브라우저에서 7연속 blob 다운로드는 ①`await` 뒤라 사용자 제스처가 소멸해 조용히 차단되고
 * ②"여러 파일 다운로드 허용?" 프롬프트까지 겹쳐 실사용에서 0건 다운로드가 났다(2026-08-24 실측).
 * JPEG 는 이미 압축돼 있어 deflate 이득이 없으므로 store(무압축)면 충분하고,
 * store 포맷은 로컬헤더+중앙디렉토리+EOCD 로 구현이 짧아 jszip 의존성을 살 이유가 없다.
 *
 * 스펙: PKWARE APPNOTE — Local file header(PK\x03\x04) · Central directory(PK\x01\x02)
 *       · End of central directory(PK\x05\x06). CRC-32 는 IEEE 802.3 다항식.
 */

export interface ZipEntry {
  /** zip 안의 파일명 (ASCII 권장 — 한글은 인코딩 플래그가 필요해 피한다) */
  name: string;
  data: Uint8Array;
}

/** CRC-32 테이블 (지연 1회 생성). */
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 시각 형식(zip 헤더용). 초는 2초 단위로 절사된다 — 정보용이라 정밀도는 중요치 않다. */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * 엔트리 목록 → ZIP 바이트 (store, 무압축).
 * 엔트리 순서가 곧 zip 내 순서다 — 카드 순번이 파일명(01.jpg…)과 나열 순서 둘 다로 보존된다.
 */
export function makeZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { date, time } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    // Local file header: version 20 · flags 0 · method 0(store) · size==compressed size
    const local = cat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0),
      name, e.data,
    );
    // Central directory entry — 로컬 헤더의 오프셋을 가리킨다.
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      name,
    ));
    chunks.push(local);
    offset += local.length;
  }

  const centralBytes = cat(...central);
  const eocd = cat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  );
  return cat(...chunks, centralBytes, eocd);
}
