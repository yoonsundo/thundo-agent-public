#!/usr/bin/env node
/**
 * cardnews/gates.mjs — 카드 이미지 결정론 게이트 (계획 §3.10, AC-19)
 *
 * 사용: node scripts/cardnews/gates.mjs <renderdir>
 * 검사: 장수 7 · JPEG(SOI FFD8) · 치수 정확히 1080×1350 · 파일당 ≤8MB
 * 계약: stdout JSON 1줄 {ok, checks[], dir}. exit 0=통과 / 1=실패 / 2=실행오류
 * (`shorts/gates.mjs:68-77`·블로그 15종 게이트와 같은 계약. ffprobe 대신 **헤더 직접 파싱**
 *  이라 외부 의존성 0개.)
 *
 * ⛔ **실패해도 파일을 지우지 않는다**(AC-19) — 게이트는 판정만 하고 정리하지 않는다.
 * 호출자가 `held` 로 전이시키고, 산출물은 진단·재사용을 위해 남는다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, isMainModule } from './lib.mjs';

const log = makeLogger('cardnews/gates');

/**
 * JPEG SOF 마커에서 치수 추출. SOF0~SOF15(0xC0~0xCF) 중 C4(DHT)·C8(JPG)·CC(DAC) 는
 * 프레임 헤더가 아니라 제외한다 — 이걸 빼먹으면 허프만 테이블을 치수로 오독한다.
 * @returns {{width:number,height:number}|null} JPEG 이 아니거나 SOF 부재면 null
 */
export function readJpegDims(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;         // SOI 아님 = JPEG 아님
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    const isSOF = m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
    if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;                                   // 손상 세그먼트 — 무한루프 방지
    i += 2 + len;                                               // 세그먼트 길이만큼 점프
  }
  return null;
}

/** 디렉터리의 슬라이드 파일 목록(정렬). */
export function listSlides(dir) {
  return readdirSync(dir)
    .filter(f => /\.jpe?g$/i.test(f))
    .sort()
    .map(f => join(dir, f));
}

/** 순수 판정 — 파일 경로 배열 + gates 설정 → {ok, checks}. */
export function judge(files, cfg) {
  const g = cfg?.gates || {};
  const wantW = g.width ?? 1080, wantH = g.height ?? 1350;
  const maxBytes = g.max_bytes ?? 8388608;
  const wantCount = g.expected_count ?? 7;

  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add('count', files.length === wantCount, `${files.length}장`);

  const metas = files.map(f => {
    const buf = readFileSync(f);
    return { file: f, size: statSync(f).size, jpeg: buf[0] === 0xFF && buf[1] === 0xD8, dims: readJpegDims(buf) };
  });

  const badFmt = metas.filter(m => !m.jpeg);
  add('format', metas.length > 0 && badFmt.length === 0,
    badFmt.length ? `JPEG 아님 ${badFmt.length}건` : `jpeg×${metas.length}`);

  const badDim = metas.filter(m => !m.dims || m.dims.width !== wantW || m.dims.height !== wantH);
  add('dimensions', metas.length > 0 && badDim.length === 0,
    badDim.length
      ? `불일치 ${badDim.length}건 (예: ${badDim[0].dims ? `${badDim[0].dims.width}x${badDim[0].dims.height}` : '치수 파싱 실패'})`
      : `${wantW}x${wantH} ×${metas.length}`);

  const maxSize = metas.length ? Math.max(...metas.map(m => m.size)) : 0;
  add('filesize', metas.every(m => m.size <= maxBytes),
    `최대 ${Math.round(maxSize / 1024)}KB (상한 ${Math.round(maxBytes / 1024)}KB)`);

  return { ok: checks.every(c => c.pass), checks };
}

export function runGate(dir, cfg) {
  cfg = cfg || loadConfig();
  return judge(listSlides(dir), cfg);
}

function main() {
  const dir = process.argv[2];
  if (!dir) { log.error('사용법: cardnews/gates.mjs <renderdir>'); process.exit(2); }
  let result;
  try { result = runGate(resolve(dir)); }
  catch (e) {
    log.error(`게이트 실행 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: result.ok, checks: result.checks, dir }) + '\n');
  // 사람용 요약은 **stderr** 로만 보낸다 — stdout 은 JSON 정확히 1줄이어야 호출자가 파싱할 수 있다.
  // (`shorts/gates.mjs:75` 는 PASS 를 log.info=stdout 으로 찍어 그 줄까지 섞이는데, 여기서는
  //  계약을 문자 그대로 지킨다. shorts 는 이 스토리에서 손대지 않는다.)
  for (const c of result.checks) if (!c.pass) log.warn(`FAIL ${c.name}: ${c.detail}`);
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
