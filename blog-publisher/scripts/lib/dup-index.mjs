#!/usr/bin/env node
/**
 * lib/dup-index.mjs — 발행물 MinHash 서명 캐시
 *
 * 왜 있는가(F-17): `check-dup` 은 초안을 `published/` 전체와 대조하는데, 서명 산출이
 * 4-gram 하나마다 sha256 을 128회 돈다. 2026-08-21 실측으로 발행물 153편 전체가
 * **약 49초**, 초안까지 합쳐 **61~67초**였다. 그런데 `run-all-gates` 는 게이트를
 * **60초에 SIGKILL** 한다. 넘은 초안은 exit 2 → all_pass=false → **폐기**됐다.
 *
 * 해법은 산출식 변경이 아니라 캐싱이다. 발행물은 한 번 나가면 바뀌지 않는
 * 아카이브라, 서명을 저장해 두면 매 실행에 새로 계산할 것은 **초안 1편(약 320ms)**
 * 뿐이다. 산출식을 건드리지 않으므로 **판정은 정의상 동일하다.**
 *
 * 저장 형식: JSONL 1줄 = 발행물 1편. 하루 3편이면 하루 3줄만 늘어 diff 가 조용하다.
 *   {"file":"2026-08-21-x.md","sha":"<16hex>","grams":2262,"sig":"<base64 512B>"}
 *
 * 무효화: 파일 **내용 해시**로 판정한다. mtime 은 체크아웃·복사로 흔들리지만
 * 내용은 안 흔들린다. 내용이 바뀌면 그 줄만 다시 계산한다.
 *
 * 안전: 인덱스가 없거나 깨졌으면 **전량 재계산으로 degrade** 한다(판정 동일, 느릴 뿐).
 * 쓰기는 tmp+rename 원자적 교체라 동시 실행이 서로를 찢지 않는다.
 *
 * CLI: node scripts/lib/dup-index.mjs [--rebuild]   (npm run dup:index)
 */
import { createHash }       from 'node:crypto';
import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath }     from 'node:url';

import { charFourgrams, minHash, encodeSig, decodeSig, SIG_K } from '../kernel/minhash.mjs';
import { isMainModule }      from './main-module.mjs';

const __dir      = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT     = resolve(__dir, '../../');
export const PUBLISHED_DIR = join(REPO_ROOT, 'published');
export const INDEX_PATH    = join(REPO_ROOT, 'state', 'dup-index.jsonl');

/** 내용 해시 — 캐시 무효화 키. 64비트면 153편 규모에서 충돌은 무시할 수준. */
export function contentSha(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** YAML frontmatter 제거. check-dup 과 동일 규칙(추후 kernel/markdown 으로 통합). */
export function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * 인덱스 로드. 손상된 줄은 조용히 버린다 — 그 파일만 재계산되고 판정은 그대로다.
 * @returns {Map<string, {sha: string, grams: number, sig: number[]}>}
 */
export function loadIndex(indexPath = INDEX_PATH) {
  const map = new Map();
  if (!existsSync(indexPath)) return map;
  let text;
  try { text = readFileSync(indexPath, 'utf8'); } catch { return map; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (!rec?.file || !rec?.sha || typeof rec.sig !== 'string') continue;
    const sig = decodeSig(rec.sig, SIG_K);
    if (!sig) continue;                      // 길이 불일치 = 다른 k 로 만든 것 → 무효
    map.set(rec.file, { sha: rec.sha, grams: rec.grams ?? 0, sig });
  }
  return map;
}

/**
 * 원자적 저장. 쓰기 실패는 **던지지 않는다** — 캐시일 뿐이라 판정을 막으면 안 된다.
 * @returns {boolean} 저장 성공 여부
 */
export function saveIndex(map, indexPath = INDEX_PATH) {
  const lines = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))   // 파일명 정렬 → diff 안정
    .map(([file, v]) => JSON.stringify({
      file, sha: v.sha, grams: v.grams, sig: encodeSig(v.sig),
    }));
  const tmp = `${indexPath}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    renameSync(tmp, indexPath);                          // 원자적 교체
    return true;
  } catch (e) {
    process.stderr.write(`dup-index: 저장 실패(판정은 계속): ${e.message}\n`);
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 정리 실패는 무시 */ }
    return false;
  }
}

/**
 * 발행물 서명을 확보한다. 캐시에 있으면 쓰고, 없거나 내용이 바뀐 것만 계산한다.
 * 삭제된 파일은 인덱스에서 정리한다.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.files]         대상 파일명(publishedDir 기준). 없으면 아무것도 하지 않는다
 * @param {string}   [opts.publishedDir]  기본 PUBLISHED_DIR
 * @param {string}   [opts.indexPath]     기본 INDEX_PATH
 * @param {boolean}  [opts.write]         변경분을 디스크에 반영할지(기본 true)
 * @returns {{ sigs: Map<string, number[]>, computed: number, cached: number, saved: boolean }}
 */
export function ensureSignatures({
  files = [], publishedDir = PUBLISHED_DIR, indexPath = INDEX_PATH, write = true,
} = {}) {
  const index = loadIndex(indexPath);
  const sigs  = new Map();
  let computed = 0, cached = 0, dirty = false;

  for (const fname of files) {
    let raw;
    try { raw = readFileSync(join(publishedDir, fname), 'utf8'); }
    catch { continue; }                       // 읽기 실패한 파일은 비교 대상에서 빠진다

    const sha = contentSha(raw);
    const hit = index.get(fname);
    if (hit && hit.sha === sha) {
      sigs.set(fname, hit.sig);
      cached++;
      continue;
    }

    const grams = charFourgrams(stripFrontmatter(raw));
    if (grams.size === 0) {                   // 빈 본문은 비교 대상 아님(원본 동작 유지)
      index.delete(fname);
      dirty = true;
      continue;
    }
    const sig = minHash(grams);
    index.set(fname, { sha, grams: grams.size, sig });
    sigs.set(fname, sig);
    computed++;
    dirty = true;
  }

  // 발행물에서 사라진 항목 정리
  const alive = new Set(files);
  for (const key of [...index.keys()]) {
    if (!alive.has(key)) { index.delete(key); dirty = true; }
  }

  const saved = dirty && write ? saveIndex(index, indexPath) : false;
  return { sigs, computed, cached, saved };
}

/** published/*.md 목록 */
export function listPublished(publishedDir = PUBLISHED_DIR) {
  try { return readdirSync(publishedDir).filter(f => f.endsWith('.md')); }
  catch { return []; }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url)) {
  const rebuild = process.argv.includes('--rebuild');
  if (rebuild && existsSync(INDEX_PATH)) {
    try { unlinkSync(INDEX_PATH); } catch { /* 없으면 그만 */ }
  }
  const files = listPublished();
  const t0 = Date.now();
  const r = ensureSignatures({ files });
  process.stdout.write(
    `dup-index: 발행물 ${files.length}편 — 캐시적중 ${r.cached} / 재계산 ${r.computed} / ` +
    `저장 ${r.saved ? 'yes' : 'no'} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`
  );
  process.exit(0);
}
