#!/usr/bin/env node
/**
 * crosspub/rewrite.mjs — published/ 1편을 플랫폼 톤으로 실 LLM 변형 재작성
 *
 * 사용: node scripts/crosspub/rewrite.mjs <published/….md> --platform <tistory|velog|medium>
 *
 * scripts/naver/rewrite-for-naver.mjs 의 플랫폼-일반화 복제(원본 무수정 보존).
 * 실 LLM 필수(mock 하네스 금지 — 프로젝트 하드 제약): 구독 claude CLI
 * (-p --output-format json) 경로. CLI 부재 시 exit 2.
 *
 * 유사도: ko 플랫폼은 naver check-rewrite-similarity 의 jaccardOfTexts/judgeBand 를
 * import 재사용(밴드는 config/crosspub.json). medium 은 교차언어(en) 재작성이라
 * 4-gram Jaccard 가 무의미 → similarity_check=false 로 SKIP 판정 명시.
 *
 * 계약: stdout JSON 1줄 {ok, platform, slug, pending|rejected, similarity, tokens}
 *       exit 0=pending 적재 / 1=밴드 fail(rejected 보존) / 2=실행오류
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';
import { charge } from '../watchdog/budget.mjs';
import { jaccardOfTexts, judgeBand } from '../naver/check-rewrite-similarity.mjs';
import { loadCrosspubConfig, parseDoc, platformDirs, queueRoot, tokensLogPath, REPO_ROOT } from './lib.mjs';
import '../lib/force-subscription.mjs'; // 구독 강제(claude 직접 spawn 방어)

const log = makeLogger('crosspub/rewrite');

/** 플랫폼별 재작성 지침 — 사실 불변·표현 변형 원칙은 공통 */
const PLATFORM_BRIEFS = {
  tistory: `너는 티스토리 블로그 운영자다. 아래 [원문]을 **티스토리 독자 톤으로 "변형 재작성"** 하되, 아래 [티스토리 리치 구성]을 반드시 지켜 단조롭지 않게 만들어라.
- 친근하고 설명적인 정보 블로그 문체(존댓말), 소제목은 궁금증을 끄는 문장형으로.
- 출력은 한국어.

[티스토리 리치 구성 — 필수]
1. **리드**: 맨 앞에 이 글을 왜 읽어야 하는지 핵심을 3~4줄로 요약(제목 반복 금지, 바로 본론 가치).
2. **소제목(## )은 3개 이상**, 각 소제목 아래는 스캔 가능한 짧은 문단(2~4줄) + 필요한 곳엔 순서/불릿 목록.
3. **핵심 포인트·주의사항은 인용(> )으로 콜아웃** — 글 전체에 인용 블록 1개 이상 넣어 시각적 리듬을 준다.
4. 단계·비교·수치는 **목록이나 표**로 정리(평문 나열 금지). 목록 1개 이상 필수.
5. **마무리 소제목**에 3줄 내외 요약 + 자연스러운 원문 유도 문장.
6. 사실·수치·주장·결론은 원문과 동일 유지 — 구성·표현만 강화하고 없는 내용 창작 금지.`,
  velog: `너는 velog 에 글을 쓰는 현업 개발자다. 아래 [원문]을 **velog 개발자 독자 톤으로 "변형 재작성"** 하라.
- 실전·경험 공유 톤(간결한 해요체/평서 혼용), 군더더기 없는 기술 서술.
- 코드·설정·수치는 원문 그대로 유지하고, 개발자가 바로 써먹을 포인트를 앞세운다.
- 출력은 한국어.`,
  medium: `You are a tech writer publishing on Medium. The [원문] below is a Korean tech blog post already published on our site (thundo.kr).
**Rewrite it as an original-feeling English article for Medium readers** — this is a translation-rewrite, not a literal translation.
- Keep every fact, number, claim and conclusion identical to the source. Do not invent anything.
- Natural, essay-like Medium tone; restructure paragraphs and headings freely for English readers.
- Output must be entirely in English (the backlink line stays as-is).`,
};

const COMMON_RULES = `
[공통 원칙]
- 사실·수치·핵심 주장·결론은 원문과 동일하게 유지(왜곡·창작 금지). 표현·구성·말투만 바꾼다.
- 단순 복붙·문장 순서만 바꾸기는 금지. 문장 구조·어휘·연결어를 실제로 바꿔라.
- 마크다운으로 출력(제목 #, 소제목 ##, 목록 -). 과장 광고 문구·이모지 남발 금지.
- 이미지 마크다운은 재작성 대상이 아니다 — 외부 게시엔 텍스트만 나가고 이미지는 원문(역링크)에서 보게 한다.

[역링크 — 필수]
- 글 맨 마지막 줄에 정확히 이 형식의 원문 역링크를 포함하라(다른 말 붙이지 말 것):
원문: {BACKLINK}

[출력 형식]
- 설명·머리말·코드펜스 없이 **재작성된 본문(마크다운)만** 출력하라.
`;

/** 순수 함수: 플랫폼 프롬프트 조립 (단위테스트 대상) */
export function buildPrompt(platform, fm, body, backlinkUrl) {
  const brief = PLATFORM_BRIEFS[platform];
  if (!brief) throw new Error(`알 수 없는 플랫폼: ${platform}`);
  const title = fm.title || '(제목 미상)';
  return `${brief}\n${COMMON_RULES.replace('{BACKLINK}', backlinkUrl)}\n[원문 제목]\n${title}\n\n[원문 본문]\n${body}\n`;
}

/**
 * 순수 함수: 원문 frontmatter 의 tags 문자열 → 태그 배열 (단위테스트 대상).
 * parseDoc 는 `tags: ["a","b"]` 를 통짜 문자열로 준다. JSON 배열 우선, 실패 시
 * 쉼표/해시 구분. 공백·중복·빈값 정리, 최대 10개.
 */
export function parseTags(raw) {
  if (!raw || typeof raw !== 'string') return [];
  let arr = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    // JSON 배열 형태면 파싱만 시도 — 실패/빈배열이어도 리터럴 split 로 폴백하지 않는다
    // (깨진 JSON 을 쉼표로 쪼개면 '[]' 같은 정크 태그가 생김)
    try { arr = JSON.parse(trimmed); } catch { return []; }
  } else {
    arr = trimmed.replace(/^#/, '').split(/[,#]/);
  }
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const tag = String(t).trim().replace(/^["']|["']$/g, '');
    if (tag && !seen.has(tag)) { seen.add(tag); out.push(tag); }
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * 순수 함수: 글의 제목·태그를 category_rules 키워드에 순서대로 매칭해 카테고리 결정.
 * 첫 일치 규칙의 category, 없으면 defaultCategory. (단위테스트 대상)
 */
export function pickCategory({ title, tags }, rules, defaultCategory) {
  const hay = `${title || ''} ${(tags || []).join(' ')}`.toLowerCase();
  for (const rule of rules || []) {
    if ((rule.keywords || []).some(k => hay.includes(String(k).toLowerCase()))) {
      return rule.category;
    }
  }
  return defaultCategory || '';
}

/** 순수 함수: 역링크 보장 — LLM 이 빠뜨렸으면 말미에 강제 추가 (단위테스트 대상) */
export function ensureBacklink(text, backlinkUrl) {
  if (text.includes(backlinkUrl)) {
    return /\n$/.test(text) ? text : text + '\n';
  }
  return text.replace(/\s*$/, '') + `\n\n원문: ${backlinkUrl}\n`;
}

function estimateTokens(text) {
  return Math.max(1, Math.round([...(text || '')].length / 4));
}

function callClaude(prompt) {
  let raw;
  try {
    raw = execFileSync('claude', ['-p', '--output-format', 'json', '--dangerously-skip-permissions'], {
      input: prompt, encoding: 'utf8', timeout: 300_000, maxBuffer: 40 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('claude CLI 를 찾을 수 없다(구독 LLM 부재). 실 LLM 없이는 재작성 불가.');
    const stderr = (e.stderr || '').toString().slice(0, 400);
    throw new Error(`claude 실행 실패: ${e.message}${stderr ? ' :: ' + stderr : ''}`);
  }
  let env;
  try { env = JSON.parse(raw); }
  catch { throw new Error('claude --output-format json 출력 파싱 실패'); }
  if (env.is_error || env.subtype !== 'success' || typeof env.result !== 'string') {
    throw new Error(`claude 응답 오류: subtype=${env.subtype} error=${env.is_error}`);
  }
  const text = env.result.replace(/^```\w*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
  const usage = env.usage || {};
  const hasReal = Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens);
  return {
    text,
    input_tokens: hasReal ? usage.input_tokens : estimateTokens(prompt),
    output_tokens: hasReal ? usage.output_tokens : estimateTokens(text),
    estimated: !hasReal,
  };
}

/** 순수 함수: 유사도 판정 — similarity_check=false 플랫폼은 SKIP (단위테스트 대상) */
export function judgeSimilarity(origRaw, rewriteBody, platformCfg, band) {
  if (!platformCfg?.similarity_check) {
    return { verdict: 'SKIP', reason: '교차언어 재작성 — Jaccard 밴드 미적용', jaccard: null };
  }
  const { jaccard } = jaccardOfTexts(origRaw, rewriteBody);
  const { pass, reason } = judgeBand(jaccard, band);
  return { verdict: pass ? 'PASS' : 'FAIL', reason, jaccard: parseFloat(jaccard.toFixed(4)) };
}

function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--platform');
  const platform = pi >= 0 ? args[pi + 1] : null;
  const srcArg = args.find(a => !a.startsWith('--') && a !== platform);
  if (!srcArg || !platform) {
    process.stderr.write('Usage: rewrite.mjs <published/….md> --platform <tistory|velog|medium>\n');
    process.exit(2);
  }

  let cfg;
  try { cfg = loadCrosspubConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }
  const platformCfg = cfg.platforms?.[platform];
  if (!platformCfg) { log.error(`crosspub.json 에 없는 플랫폼: ${platform}`); process.exit(2); }

  const srcPath = resolve(srcArg);
  let raw;
  try { raw = readFileSync(srcPath, 'utf8'); }
  catch (e) { log.error(`원문 읽기 실패: ${e.message}`); process.exit(2); }

  const { fm, body } = parseDoc(raw);
  const slug = fm.slug || srcPath.split('/').pop().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const backlinkUrl = `${(cfg.site_base_url || 'https://www.thundo.kr/blog').replace(/\/$/, '')}/${slug}`;
  const prompt = buildPrompt(platform, fm, body, backlinkUrl);

  log.info(`재작성: ${slug} → ${platform}${platformCfg.lang === 'en' ? ' (영어 번역 재작성)' : ''}`);
  let res;
  try { res = callClaude(prompt); }
  catch (e) { log.error(e.message); process.exit(2); }

  const outBody = ensureBacklink(res.text, backlinkUrl);
  const sim = judgeSimilarity(raw, outBody, platformCfg, cfg.similarity_band || { min: 0.3, max: 0.6 });

  // 토큰 실측 기록 + 예산 차감 (기존 watchdog 재사용)
  const tokRec = {
    ts: new Date().toISOString(), platform, slug,
    input_tokens: res.input_tokens, output_tokens: res.output_tokens,
    ...(res.estimated ? { estimated: true } : {}),
  };
  mkdirSync(queueRoot(), { recursive: true });
  appendFileSync(tokensLogPath(), JSON.stringify(tokRec) + '\n', 'utf8');
  try { charge(res.input_tokens + res.output_tokens, 1, `crosspub:${platform}`); }
  catch (e) { log.warn(`예산 차감 실패(계속): ${e.message}`); }

  const dirs = platformDirs(platform);
  const date = new Date().toISOString().slice(0, 10);
  const outName = `${date}-${slug}.${platform}.md`;
  const tags = parseTags(fm.tags);
  const tagsLine = tags.length ? `crosspub_tags: ${tags.join(', ')}\n` : '';
  // 카테고리: 글별 규칙 매칭(제목·태그) → crosspub_category 로 전달
  const category = pickCategory({ title: fm.title, tags }, platformCfg.category_rules, platformCfg.category);
  const catLine = category ? `crosspub_category: ${category}\n` : '';
  const header = `---\nsource: ${srcPath.replace(REPO_ROOT + '/', '')}\nslug: ${slug}\nplatform: ${platform}\nsource_url: ${backlinkUrl}\ntitle: "${(fm.title || '').replace(/"/g, '\\"')}"\ngenerated: ${new Date().toISOString()}\nsimilarity: ${sim.verdict}${sim.jaccard != null ? ` (jaccard=${sim.jaccard})` : ''}\n${tagsLine}${catLine}---\n\n`;

  if (sim.verdict === 'FAIL') {
    const rejDir = join(dirs.root, 'rejected');
    mkdirSync(rejDir, { recursive: true });
    const rejPath = join(rejDir, outName);
    writeFileSync(rejPath, header + outBody, 'utf8');
    log.warn(`유사도 밴드 FAIL — rejected 보존: ${sim.reason}`);
    process.stdout.write(JSON.stringify({
      ok: false, platform, slug, rejected: rejPath.replace(REPO_ROOT + '/', ''), similarity: sim, tokens: tokRec,
    }) + '\n');
    process.exit(1);
  }

  mkdirSync(dirs.pending, { recursive: true });
  const outPath = join(dirs.pending, outName);
  writeFileSync(outPath, header + outBody, 'utf8');
  log.info(`pending 적재: ${outPath.replace(REPO_ROOT + '/', '')} [similarity=${sim.verdict}]`);
  process.stdout.write(JSON.stringify({
    ok: true, platform, slug, pending: outPath.replace(REPO_ROOT + '/', ''), similarity: sim, tokens: tokRec,
  }) + '\n');
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
