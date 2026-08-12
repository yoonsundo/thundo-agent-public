#!/usr/bin/env node
/**
 * check-dup.mjs — 문자 4-gram MinHash(k=128) Jaccard 중복 검사
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');
const PUBLISHED_DIR = join(REPO_ROOT, 'published');
const CONFIG_PATH = join(REPO_ROOT, 'config', 'pipeline.json');

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { dedup: { max_jaccard: 0.25 } };
  }
}

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** 문자 4-gram 집합 생성 */
function charFourgrams(text) {
  const chars = [...text.replace(/\s+/g, ' ')];
  const grams = new Set();
  for (let i = 0; i <= chars.length - 4; i++) {
    grams.add(chars.slice(i, i + 4).join(''));
  }
  return grams;
}

/** MinHash 서명 (k=128, MurmurHash 대신 sha256 슬라이싱) */
function minHash(grams, k = 128) {
  const sig = new Array(k).fill(Infinity);
  for (const gram of grams) {
    for (let i = 0; i < k; i++) {
      const h = createHash('sha256')
        .update(`${i}:${gram}`)
        .digest();
      // 32비트 부호없는 정수
      const val = h.readUInt32BE(0);
      if (val < sig[i]) sig[i] = val;
    }
  }
  return sig;
}

/** MinHash 서명 두 개의 추정 Jaccard */
function jaccardFromSigs(a, b) {
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) same++;
  }
  return same / a.length;
}

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-dup.mjs <draft.md>\n');
    process.exit(2);
  }

  let draftRaw;
  try {
    draftRaw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-dup: 초안 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const config = loadConfig();
  const MAX_JACCARD = config?.dedup?.max_jaccard ?? 0.25;

  const draftBody = stripFrontmatter(draftRaw);
  const draftGrams = charFourgrams(draftBody);

  if (draftGrams.size === 0) {
    const result = { gate: 'dup', pass: false, reason: '본문이 비어있어 4-gram 생성 불가', evidence: { max_jaccard: 1, matched_file: null } };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(1);
  }

  const draftSig = minHash(draftGrams);

  // mock 모드에서는 같은 날짜 배치 내 파일을 중복 비교 대상에서 제외.
  // mock 초안은 템플릿 기반이라 같은 런에서 발행된 파일과 Jaccard가 높게 나오는
  // 구조적 특성이 있음. 실제 dedup은 step2의 dedup_key(제목+키워드 해시)가 담당.
  const IS_MOCK = process.env.RUN_MODE === 'mock';
  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  let maxJ = 0;
  let matchedFile = null;

  let publishedFiles;
  try {
    publishedFiles = readdirSync(PUBLISHED_DIR).filter(f => f.endsWith('.md'));
  } catch {
    publishedFiles = [];
  }

  for (const fname of publishedFiles) {
    // mock 모드: 오늘 날짜 배치 내 파일은 비교 제외
    if (IS_MOCK && fname.startsWith(todayPrefix)) continue;
    const fpath = join(PUBLISHED_DIR, fname);
    // 자기 자신 건너뜀
    if (resolve(fpath) === resolve(draftPath)) continue;
    let raw;
    try {
      raw = readFileSync(fpath, 'utf8');
    } catch {
      continue;
    }
    const body = stripFrontmatter(raw);
    const grams = charFourgrams(body);
    if (grams.size === 0) continue;
    const sig = minHash(grams);
    const j = jaccardFromSigs(draftSig, sig);
    if (j > maxJ) {
      maxJ = j;
      matchedFile = fname;
    }
  }

  const pass = maxJ < MAX_JACCARD;
  const result = {
    gate: 'dup',
    pass,
    reason: pass
      ? `최대 Jaccard ${maxJ.toFixed(4)} < 임계 ${MAX_JACCARD}`
      : `중복 의심: Jaccard ${maxJ.toFixed(4)} >= 임계 ${MAX_JACCARD} (${matchedFile})`,
    evidence: {
      max_jaccard: parseFloat(maxJ.toFixed(4)),
      matched_file: matchedFile,
    },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
