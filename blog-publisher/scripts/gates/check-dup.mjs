#!/usr/bin/env node
/**
 * check-dup.mjs — 문자 4-gram MinHash(k=128) Jaccard 중복 검사
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 2026-08-21(F-17): 발행물 서명을 매번 새로 계산하느라 61~67초가 걸렸고,
 * `run-all-gates` 의 게이트별 상한 60초에 SIGKILL 당해 초안이 폐기되고 있었다.
 * 서명 산출식(kernel/minhash.mjs)은 **그대로 두고** 발행물 서명만 캐시한다
 * (lib/dup-index.mjs). 매 실행에 새로 계산하는 것은 초안 1편뿐이라 판정은 동일하고
 * 소요만 61s → 1s 미만이 된다. 캐시가 없거나 깨져도 전량 재계산으로 degrade 한다.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { charFourgrams, minHash, jaccardFromSigs } from '../kernel/minhash.mjs';
import { ensureSignatures, listPublished, stripFrontmatter, PUBLISHED_DIR } from '../lib/dup-index.mjs';


import { runGateCli, GateError, loadGateConfig } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

// 설정은 config/pipeline.json 하나가 단일 출처다 — 읽기에 실패하면 코드의 기본값으로
// 폴백하지 않고 던진다(옛 기준으로 조용히 판정하는 것이 최악이다).
function loadConfig() {
  return loadGateConfig(readFileSync);
}

export function evaluate(draftPath) {

  let draftRaw;
  try {
    draftRaw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`초안 파일 읽기 실패: ${e.message}`, { cause: e });
  }

  const config = loadConfig();
  const MAX_JACCARD = config?.dedup?.max_jaccard ?? 0.25;

  const draftBody = stripFrontmatter(draftRaw);
  const draftGrams = charFourgrams(draftBody);

  if (draftGrams.size === 0) {
    const result = { gate: 'dup', pass: false, reason: '본문이 비어있어 4-gram 생성 불가', evidence: { max_jaccard: 1, matched_file: null } };
    return result;
  }

  const draftSig = minHash(draftGrams);

  // mock 모드에서는 같은 날짜 배치 내 파일을 중복 비교 대상에서 제외.
  // mock 초안은 템플릿 기반이라 같은 런에서 발행된 파일과 Jaccard가 높게 나오는
  // 구조적 특성이 있음. 실제 dedup은 step2의 dedup_key(제목+키워드 해시)가 담당.
  const IS_MOCK = process.env.RUN_MODE === 'mock';
  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const publishedFiles = listPublished();

  // 서명은 인덱스에서 가져온다. 새로 발행된 파일(하루 3편)만 여기서 계산되고
  // 갱신분은 인덱스에 반영된다. 필터(mock 배치·자기 자신)는 **비교 시점**에 거는데,
  // 인덱싱 시점에 걸면 그 파일이 캐시에서 빠져 다음 런이 다시 계산하기 때문이다.
  const { sigs } = ensureSignatures({ files: publishedFiles });

  let maxJ = 0;
  let matchedFile = null;

  for (const fname of publishedFiles) {
    // mock 모드: 오늘 날짜 배치 내 파일은 비교 제외
    if (IS_MOCK && fname.startsWith(todayPrefix)) continue;
    // 자기 자신 건너뜀
    if (resolve(join(PUBLISHED_DIR, fname)) === resolve(draftPath)) continue;

    const sig = sigs.get(fname);
    if (!sig) continue;                 // 읽기 실패·빈 본문 → 원본과 동일하게 건너뜀

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

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'dup',
    evaluate,
    usage: 'Usage: check-dup.mjs <draft.md>',
  });
}