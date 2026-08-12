#!/usr/bin/env node
/**
 * curiosity-insights-loop.test.mjs — 자가발전 폐루프(성과 인사이트 → 프롬프트 주입) 유닛테스트
 *
 * evolve.mjs 가 남기는 state/shorts-curiosity/insights.json 을 발굴(backlog)·대본(script)
 * 프롬프트가 실제로 반영하는지, 그리고 파일이 없거나 깨졌을 때 조용히 기존 동작으로
 * 폴백하는지 검증한다. 순수 프롬프트 빌더만 호출 → 네트워크·claude 호출 없음.
 * 인사이트 경로는 CURIOSITY_INSIGHTS_PATH 로 임시 디렉터리에 격리(실 state 무오염).
 *
 * exit 0 = 전체 통과 / 1 = 실패
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠ import 보다 먼저 경로를 격리해야 한다(모듈 로드시 실 state 를 만지지 않도록).
const TMP = mkdtempSync(join(tmpdir(), 'curio-insights-'));
const INS_PATH = join(TMP, 'insights.json');
process.env.CURIOSITY_INSIGHTS_PATH = INS_PATH;

const { loadConfig } = await import('../shorts-curiosity/lib.mjs');
const {
  loadInsights, insightsBacklogBlock, buildPrompt: buildBacklogPrompt,
  buildReframePrompt, buildWhatIfPrompt, INSIGHTS_MAX_AGE_DAYS,
} = await import('../shorts-curiosity/backlog.mjs');
const { buildPrompt: buildScriptPrompt, insightsScriptBlock } = await import('../shorts-curiosity/script.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const has = (label, hay, needle) => ok(label, String(hay).includes(needle), `"${needle}" 없음`);
const hasNot = (label, hay, needle) => ok(label, !String(hay).includes(needle), `"${needle}" 가 있음`);

/** 인사이트 파일 세팅(raw 문자열 그대로 쓰기 — 깨진 JSON 도 테스트하려고). */
const setInsights = (raw) => writeFileSync(INS_PATH, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2), 'utf8');
const clearInsights = () => { if (existsSync(INS_PATH)) rmSync(INS_PATH); };

/** 로그를 잡아두는 페이크 로거. */
const capture = () => {
  const lines = [];
  const rec = (lvl) => (m, extra) => lines.push(`[${lvl}] ${m}${extra !== undefined ? ' ' + String(extra) : ''}`);
  return { lines, debug: rec('DEBUG'), info: rec('INFO'), warn: rec('WARN'), error: rec('ERROR') };
};

const cfg = loadConfig();
const SUBJECTS = ['기존 주제 A', '기존 주제 B'];
const SEEDS = [{ subreddit: 'todayilearned', fact: 'A cat has 32 muscles in each ear.' }];
const ITEM = {
  id: 'abc123', subject: '테스트 주제', common_belief: '흔한 믿음', reveal: '반전 사실',
  source_hint: '근거기관', domain: '기술', angle: 'reveal',
};

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const FRESH = {
  generated_at: iso(1),
  sample_size: 42,
  top_domains: ['역사', '인체'],
  bottom_domains: ['기술', '일상'],
  top_angle: 'reveal',
  title_patterns: ['단정형 훅', '구체수치형 훅'],
};

// ── (a) 유효 인사이트 → 발굴·대본 프롬프트에 상위/하위 도메인·표본수가 실제로 포함 ──
console.log('\n(a) 유효 insights.json 주입');
setInsights(FRESH);
{
  const ins = loadInsights();
  ok('loadInsights 가 객체 반환', !!ins);
  ok('strength=full (신선+표본충분)', ins?.strength === 'full', `strength=${ins?.strength}`);

  const bl = buildBacklogPrompt(cfg, SUBJECTS, 10, ins);
  has('발굴: 상위 도메인 역사', bl, '역사');
  has('발굴: 상위 도메인 인체', bl, '인체');
  has('발굴: 하위 도메인 라벨', bl, '부진** 도메인: 기술, 일상');
  has('발굴: 표본수 명시', bl, '표본 42편');
  has('발굴: 우수도메인 증량 지시', bl, '우수 도메인 비중을 높이고');
  has('발굴: 편중 상한(다양성 보호)', bl, '60%');
  has('발굴: 기존 규칙 유지(클리셰 금지)', bl, '닳은 클리셰 금지');
  has('발굴: 기존 규칙 유지(이미 있는 주제)', bl, '[이미 있는 주제]');

  const rf = buildReframePrompt(cfg, SUBJECTS, SEEDS, 7, ins);
  has('reddit 재구성: 인사이트 주입', rf, '성과 우수** 도메인: 역사, 인체');
  has('reddit 재구성: 씨앗 목록 유지', rf, 'A cat has 32 muscles');

  const wi = buildWhatIfPrompt(cfg, SUBJECTS, 3, ins);
  has('whatif: 인사이트 주입', wi, '표본 42편');
  has('whatif: 기존 스키마 유지', wi, '"angle": "whatif"');

  const sc = buildScriptPrompt(ITEM, cfg, ins);
  has('대본: 훅 패턴 반영', sc, '단정형 훅 / 구체수치형 훅');
  has('대본: 상위 도메인', sc, '성과 우수 도메인: 역사, 인체');
  has('대본: 하위 도메인', sc, '성과 부진 도메인: 기술, 일상');
  has('대본: 표본수 명시', sc, '표본 42편');
  has('대본: 부진 도메인 소재 경고', sc, '이 소재의 도메인(기술)은 부진군');
  has('대본: 기존 규칙 유지(TTS 친화)', sc, '[TTS 친화');
  has('대본: 기존 규칙 유지(출력 스키마)', sc, '"hook_image_prompt"');
}

// ── (a-2) evolve.mjs 가 실제로 쓰는 shorts-curiosity/insights/v1 스키마 호환 ──
// 키 이름이 lead 가 예고한 것과 다르다(weak_domains·angles·title_length·sample.videos·guidance).
// 별칭 처리가 깨지면 폐루프가 조용히 끊기므로 실제 산출 형태를 고정 테스트한다.
console.log('\n(a-2) evolve v1 실제 스키마 호환');
setInsights({
  schema: 'shorts-curiosity/insights/v1',
  generated_at: iso(1),
  goal: '구독자 500',
  sample: { videos: 37, normalization: '게시 후 경과일 정규화' },
  baseline: { meanVpd: 120 },
  top_domains: [{ key: '역사', n: 6, perf: 1.82 }, { key: '인체', n: 5, perf: 1.31 }],
  weak_domains: [{ key: '기술', n: 4, perf: 0.41 }],
  angles: [{ key: 'reveal', n: 20, perf: 1.2 }, { key: 'whatif', n: 9, perf: 0.8 }],
  title_length: [{ key: '18-24', n: 11, perf: 1.44 }],
  guidance: [
    '성과 상위 도메인: 역사(1.82), 인체(1.31) — 이 계열 소재를 우선 발굴.',
    '제목 길이 18-24자 구간이 성과 최고(상대성과 1.44) — 제목을 이 길이에 맞춰라.',
  ],
  top_videos: [{ subject: '어떤 주제', views: 9000, domain: '역사' }],
});
{
  const ins = loadInsights();
  ok('evolve v1: 로드 성공', !!ins);
  ok('sample.videos → sample_size', ins?.sample_size === 37, `sample_size=${ins?.sample_size}`);
  ok('weak_domains → bottom_domains', ins?.bottom_domains?.[0]?.startsWith('기술'), JSON.stringify(ins?.bottom_domains));
  ok('angles → top_angle', ins?.top_angle?.startsWith('reveal'), String(ins?.top_angle));
  ok('세그먼트 perf·표본 라벨화', ins?.top_domains?.[0] === '역사(상대성과 1.82, 6편)', JSON.stringify(ins?.top_domains));
  ok('title_length 추출', ins?.title_length === '18-24(상대성과 1.44, 11편)', String(ins?.title_length));
  ok('guidance 2줄 보존', ins?.guidance?.length === 2, JSON.stringify(ins?.guidance));
  ok('strength=full', ins?.strength === 'full');

  const bl = buildBacklogPrompt(cfg, SUBJECTS, 10, ins);
  has('발굴: 상위 도메인+강도', bl, '역사(상대성과 1.82, 6편)');
  has('발굴: 하위 도메인', bl, '기술(상대성과 0.41, 4편)');
  has('발굴: 표본수', bl, '표본 37편');
  has('발굴: guidance 원문', bl, '제목 길이 18-24자 구간이 성과 최고');

  const sc = buildScriptPrompt({ ...ITEM, domain: '기술' }, cfg, ins);
  has('대본: 표본수', sc, '표본 37편');
  has('대본: 상위/하위 도메인', sc, '성과 부진 도메인: 기술(상대성과 0.41, 4편)');
  has('대본: guidance 원문', sc, '이 계열 소재를 우선 발굴');
  has('대본: 부진 도메인 소재 경고(라벨 접두 매칭)', sc, '이 소재의 도메인(기술)은 부진군');
}

// ── (b) 파일 부재 → 프롬프트가 기존과 동일 + 예외 없음 ──
console.log('\n(b) insights.json 부재 → 무주입·동일 프롬프트');
clearInsights();
{
  let ins, threw = null;
  try { ins = loadInsights(); } catch (e) { threw = e; }
  ok('예외 없음', threw === null, String(threw));
  ok('null 반환', ins === null, `ins=${JSON.stringify(ins)}`);

  const baseline = buildBacklogPrompt(cfg, SUBJECTS, 10);           // ins 미전달 = 기존 시그니처
  ok('발굴: ins=null 이 기존 호출과 동일', buildBacklogPrompt(cfg, SUBJECTS, 10, null) === baseline);
  hasNot('발굴: 성과 블록 없음', baseline, '최근 유튜브 성과');
  const scBase = buildScriptPrompt(ITEM, cfg);
  ok('대본: ins=null 이 기존 호출과 동일', buildScriptPrompt(ITEM, cfg, null) === scBase);
  hasNot('대본: 성과 블록 없음', scBase, '최근 유튜브 성과');
  ok('발굴 블록 빌더도 빈 문자열', insightsBacklogBlock(null) === '');
  ok('대본 블록 빌더도 빈 문자열', insightsScriptBlock(null, ITEM) === '');

  // 손으로 만든(정규화 안 된) ins 가 들어와도 throw 금지 — 폐루프가 발행을 죽이면 안 된다.
  for (const [label, bad] of [
    ['빈 객체', {}],
    ['배열 아닌 필드', { top_domains: '역사', bottom_domains: 42, title_patterns: null, guidance: 'x' }],
    ['문자열', 'nope'],
    ['숫자', 7],
  ]) {
    let threw = null;
    try { insightsBacklogBlock(bad); insightsScriptBlock(bad, ITEM); buildScriptPrompt(ITEM, cfg, bad); }
    catch (e) { threw = e; }
    ok(`비정형 ins(${label}) 예외 없음`, threw === null, String(threw));
  }
}

// ── (c) 깨진 JSON / 예상 키 부재 / 빈 객체 / 빈 파일 → 예외 없이 무주입 ──
console.log('\n(c) 손상·무의미 인사이트 → 예외 없이 무주입');
for (const [label, raw] of [
  ['깨진 JSON', '{ "top_domains": ['],
  ['빈 파일', ''],
  ['공백만', '   \n  '],
  ['빈 객체', '{}'],
  ['예상 키 없음', '{"foo":1,"bar":["x"]}'],
  ['배열 루트', '[1,2,3]'],
  ['null 루트', 'null'],
  ['키는 있으나 전부 빈값', '{"top_domains":[],"bottom_domains":{},"title_patterns":null,"sample_size":10}'],
]) {
  setInsights(raw);
  let ins, threw = null;
  try { ins = loadInsights(); } catch (e) { threw = e; }
  ok(`${label}: 예외 없이 null`, threw === null && ins === null, `threw=${threw} ins=${JSON.stringify(ins)}`);
  if (threw === null) {
    hasNot(`${label}: 발굴 프롬프트 무주입`, buildBacklogPrompt(cfg, SUBJECTS, 10, ins), '최근 유튜브 성과');
  }
}

// ── 스키마 유연성: 객체맵·객체배열·스칼라도 라벨로 정규화 ──
console.log('\n(c-2) 스키마 변형 유연 처리');
setInsights({
  generated_at: iso(2), sample_size: 12,
  top_domains: { 역사: 1.8, 인체: 1.4 },                       // 객체맵
  bottom_domains: [{ domain: '기술', views: 100 }],            // 객체배열
  top_angle: ['whatif'],                                       // 배열
  title_patterns: '숫자 충격형',                                // 스칼라
});
{
  const ins = loadInsights();
  ok('객체맵 top_domains 정규화', ins?.top_domains?.[0] === '역사(1.8)', JSON.stringify(ins?.top_domains));
  ok('객체배열 bottom_domains 정규화', ins?.bottom_domains?.[0] === '기술', JSON.stringify(ins?.bottom_domains));
  ok('배열 top_angle → 스칼라', ins?.top_angle === 'whatif', String(ins?.top_angle));
  ok('스칼라 title_patterns → 배열', ins?.title_patterns?.[0] === '숫자 충격형', JSON.stringify(ins?.title_patterns));
  has('발굴 프롬프트에 반영', buildBacklogPrompt(cfg, SUBJECTS, 10, ins), '역사(1.8)');
}

// 한 겹 감싼 형태({insights:{...}})도 언랩
setInsights({ generated_at: iso(1), insights: { ...FRESH, sample_size: 9 } });
ok('{insights:{...}} 언랩', loadInsights()?.top_domains?.[0] === '역사');

// ── (d) 오래된 인사이트 → weak 강등(약한 참고만, 강한 증량 지시 금지) ──
console.log(`\n(d) 신선도 규칙 (>${INSIGHTS_MAX_AGE_DAYS}일 = stale → weak 강등)`);
setInsights({ ...FRESH, generated_at: iso(INSIGHTS_MAX_AGE_DAYS + 6) });
{
  const ins = loadInsights();
  ok('stale=true', ins?.stale === true);
  ok('strength=weak', ins?.strength === 'weak', `strength=${ins?.strength}`);
  ok('나이 계산', ins?.ageDays === INSIGHTS_MAX_AGE_DAYS + 6, `ageDays=${ins?.ageDays}`);
  const bl = buildBacklogPrompt(cfg, SUBJECTS, 10, ins);
  has('발굴: 약한 참고 지시', bl, '약한 참고만');
  hasNot('발굴: 강한 증량 지시 없음', bl, '우수 도메인 비중을 높이고');
  has('발굴: 집계시점 노출', bl, `${INSIGHTS_MAX_AGE_DAYS + 6}일 전 집계`);
  has('발굴: 신호 자체는 유지(버리지 않음)', bl, '역사, 인체');
  has('대본: 약한 참고 지시', buildScriptPrompt(ITEM, cfg, ins), '약한 참고만');
}

// 경계값: 정확히 MAX_AGE_DAYS 는 아직 full
setInsights({ ...FRESH, generated_at: iso(INSIGHTS_MAX_AGE_DAYS) });
ok(`경계: ${INSIGHTS_MAX_AGE_DAYS}일 = full 유지`, loadInsights()?.strength === 'full');

// 표본 부족·표본수 미상도 weak
setInsights({ ...FRESH, sample_size: 2 });
ok('표본 2편 → weak', loadInsights()?.strength === 'weak');
setInsights({ top_domains: ['역사'], sample_size: 0 });
{
  const ins = loadInsights();
  ok('표본수 0/미상 → weak', ins?.strength === 'weak');
  has('표본수 미상 라벨', buildBacklogPrompt(cfg, SUBJECTS, 10, ins), '표본수 미상');
}
// generated_at 없음 → 집계시점 미상(stale 아님, 하지만 표본 충분하면 full)
setInsights({ top_domains: ['역사'], sample_size: 30 });
{
  const ins = loadInsights();
  ok('generated_at 없음 → ageDays=null·stale=false', ins?.ageDays === null && ins?.stale === false);
  has('집계시점 미상 라벨', buildBacklogPrompt(cfg, SUBJECTS, 10, ins), '집계시점 미상');
}
// 깨진 generated_at 도 안전
setInsights({ ...FRESH, generated_at: '어제쯤?' });
ok('파싱 불가 generated_at 안전', loadInsights()?.ageDays === null);

// ── (e) 주입 시 로그 기록 ──
console.log('\n(e) 관측성 — 주입 로그');
setInsights(FRESH);
{
  const cap = capture();
  loadInsights({ logger: cap });
  const joined = cap.lines.join('\n');
  has('주입 로그 존재', joined, '인사이트 주입(full)');
  has('로그에 상위 도메인', joined, '역사');
  has('로그에 표본수', joined, '표본=42');
  has('로그에 나이', joined, '나이=1일');
}
{
  clearInsights();
  const cap = capture();
  loadInsights({ logger: cap });
  ok('부재 시 로그는 남기되 주입 로그는 없음',
    cap.lines.length > 0 && !cap.lines.join('\n').includes('인사이트 주입'), cap.lines.join(' | '));
}
{
  setInsights('{broken');
  const cap = capture();
  loadInsights({ logger: cap });
  has('깨진 JSON 경고 로그', cap.lines.join('\n'), '[WARN]');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n호기심 인사이트 폐루프: ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
