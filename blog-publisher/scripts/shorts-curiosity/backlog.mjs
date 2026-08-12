#!/usr/bin/env node
/**
 * shorts-curiosity/backlog.mjs — "설마 진짜?" 반전 사실 아이디어 백로그 보충
 *
 * 사용: node scripts/shorts-curiosity/backlog.mjs [--n 10]
 *
 * 구독 claude 로 스크롤 멈추는 반전·호기심 사실 후보를 경량 메타로 생성해 백로그에 append.
 * 풀 대본/이미지 없음(값싼 아이디어만). 기존 subject 와 중복 회피.
 * 계약: stdout JSON {ok, added, total}. exit 0 / 2=오류
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { paths } from '../lib/config.mjs';
import { loadConfig, loadBacklog, appendBacklog, callClaude, extractJson, isMainModule, loadAgentBrief } from './lib.mjs';
import { collectSeeds } from './reddit-seed.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('curiosity/backlog');
const idOf = (subject) => createHash('sha1').update(String(subject).trim()).digest('hex').slice(0, 10);

/* ──────────────────────────────────────────────────────────────────────────
 * 성과 인사이트(자가발전 폐루프) — evolve.mjs 가 매일 새벽 유튜브 성과를 집계해
 * state/shorts-curiosity/insights.json 에 남긴다. 그걸 읽어 **주제 발굴·대본 작성
 * 프롬프트에 실제로 반영**하는 게 이 블록의 역할(안 읽으면 자가발전이 가중치 장난에 그친다).
 *
 * 로더가 backlog.mjs 에 사는 이유: lib.mjs 를 건드릴 수 없고(다른 에이전트 소유),
 * 방어적 파싱 로직을 backlog/script 두 곳에 복붙하면 스키마가 확정되는 순간 갈라진다.
 * script.mjs 가 sibling 모듈에서 헬퍼를 import 하는 건 이 코드베이스의 기존 관례
 * (script.mjs → shorts/script.mjs·shorts/lib.mjs). 프롬프트 문구만 각 파일이 따로 만든다.
 *
 * 계약: 파일 부재·빈 파일·JSON 깨짐·키 부재 → 전부 null(무주입). 절대 throw 하지 않는다.
 * 스키마는 아직 미확정이라 배열/객체/스칼라 어떤 형태로 와도 라벨 배열로 정규화한다.
 * ────────────────────────────────────────────────────────────────────────── */

/** 인사이트 유효기간(일). 초과 시 stale → 강한 지시문 대신 '약한 참고'로 강등. */
export const INSIGHTS_MAX_AGE_DAYS = 14;
/** 이 표본수 미만이면 신뢰도 부족 → weak 주입(단정 금지). */
export const INSIGHTS_MIN_SAMPLE = 5;
/** 우수 도메인 편중 상한(%). freshness(도메인 다양성) 취지를 지키려면 상한이 필요하다 —
 *  성과 좋은 도메인만 뽑으면 채널이 단조로워져 스와이프 이탈이 늘고, 학습이 국소최적에 갇힌다. */
export const INSIGHTS_TOP_DOMAIN_CAP_PCT = 60;

/** 인사이트 파일 경로. 테스트 격리용 env 훅(CURIOSITY_INSIGHTS_PATH). */
export function insightsPath() {
  return process.env.CURIOSITY_INSIGHTS_PATH || join(paths.state, 'shorts-curiosity', 'insights.json');
}

/**
 * 배열/객체맵/스칼라 → 문자열 라벨 배열 정규화(중복·빈값 제거, 최대 max개).
 * - 배열 원소가 객체면 domain/angle/pattern/name/label/key 중 첫 값을 라벨로.
 *   evolve 세그먼트({key, n, perf}) 처럼 perf 가 있으면 `라벨(상대성과 1.8, 6편)` 로 강도까지 전달.
 * - 객체맵({역사: 1.4})은 `키(값)` 로 — 값이 성과 배수·설명일 수 있어 LLM 이 강도를 가늠하게 둔다.
 */
function normList(v, max = 4) {
  const out = [];
  const push = (s) => {
    const t = String(s ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };
  if (v == null) return out;
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x == null) continue;
      if (typeof x === 'object') {
        const label = String(x.domain ?? x.angle ?? x.pattern ?? x.name ?? x.label ?? x.key ?? '').trim();
        if (!label) continue;
        const perf = Number(x.perf ?? x.performance);
        const n = Number(x.n ?? x.count);
        push(Number.isFinite(perf)
          ? `${label}(상대성과 ${perf}${Number.isFinite(n) && n > 0 ? `, ${Math.floor(n)}편` : ''})`
          : label);
      } else push(x);
    }
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (x == null || typeof x === 'object') push(k);
      else push(`${k}(${x})`);
    }
  } else {
    push(v);
  }
  return out.slice(0, max);
}

/** 여러 후보 키 중 처음으로 값이 있는 것을 고른다(스키마 미확정 대응 — 별칭 허용). */
function firstKey(src, keys) {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return undefined;
}

/**
 * 성과 인사이트 로드 → 정규화 객체 또는 null(무주입).
 * @returns {null|{top_domains:string[], bottom_domains:string[], top_angle:string,
 *                 title_patterns:string[], sample_size:number, generated_at:string,
 *                 ageDays:number|null, stale:boolean, strength:'full'|'weak'}}
 */
export function loadInsights({ maxAgeDays = INSIGHTS_MAX_AGE_DAYS, logger = log } = {}) {
  const p = insightsPath();
  let raw;
  try {
    if (!existsSync(p)) { logger.debug(`인사이트 없음(${p}) → 무주입`); return null; }
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    logger.warn(`인사이트 읽기 실패(무주입): ${e.message}`);
    return null;
  }
  if (!raw || !raw.trim()) { logger.debug('인사이트 빈 파일 → 무주입'); return null; }

  let obj;
  try { obj = JSON.parse(raw); } catch { logger.warn('인사이트 JSON 파싱 실패 → 무주입'); return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { logger.warn('인사이트 형태 이상(객체 아님) → 무주입'); return null; }
  // 스키마 미확정 — { insights: {...} } 처럼 한 겹 감싸 올 수도 있어 얕은 언랩을 허용.
  const src = (obj.insights && typeof obj.insights === 'object' && !Array.isArray(obj.insights)) ? obj.insights : obj;

  // 키 별칭: evolve v1 실제 산출은 weak_domains·angles·title_length·sample.videos·guidance 를 쓴다
  // (2026-07-30 evolve.mjs 실측). 스키마가 또 바뀔 수 있으니 별칭 목록으로 받는다.
  const top_domains = normList(firstKey(src, ['top_domains', 'best_domains', 'strong_domains']));
  const bottom_domains = normList(firstKey(src, ['bottom_domains', 'weak_domains', 'worst_domains']));
  const top_angle = normList(firstKey(src, ['top_angle', 'best_angle', 'angles']), 1)[0] || '';
  const title_patterns = normList(firstKey(src, ['title_patterns', 'title_pattern', 'hook_patterns']));
  const title_length = normList(firstKey(src, ['title_length', 'title_lengths']), 1)[0] || '';
  // guidance: evolve 가 "프롬프트에 그대로 끼워 넣을 수 있게" 써 준 한국어 문장 배열 —
  // 제목길이·앵글·최고성과 사례처럼 구조화 필드로 옮기면 뉘앙스가 깨지는 것까지 담고 있어 원문 그대로 쓴다.
  const guidance = (Array.isArray(src.guidance) ? src.guidance : [])
    .map(s => String(s ?? '').trim()).filter(Boolean).slice(0, 6);

  const sampleObj = src.sample && typeof src.sample === 'object' && !Array.isArray(src.sample) ? src.sample : {};
  const nSample = Number(firstKey(src, ['sample_size', 'samples', 'n']) ?? firstKey(sampleObj, ['videos', 'size', 'count', 'n']));
  const sample_size = Number.isFinite(nSample) && nSample > 0 ? Math.floor(nSample) : 0;
  const generated_at = typeof src.generated_at === 'string' ? src.generated_at : '';

  // 쓸 신호가 하나도 없으면 무주입. ⚠ 가짜 기본값(임의의 top domain)을 만들어 주입하지 않는다.
  if (!top_domains.length && !bottom_domains.length && !top_angle && !title_patterns.length
      && !title_length && !guidance.length) {
    logger.debug('인사이트에 사용 가능한 키 없음 → 무주입');
    return null;
  }

  const t = generated_at ? Date.parse(generated_at) : NaN;
  const ageDays = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
  const stale = ageDays !== null && ageDays > maxAgeDays;
  // stale 을 완전히 버리지 않고 weak 로 강등하는 이유: evolve 는 매일 도니까 14일 초과는
  // 폐루프가 끊긴 신호다. 그 상태에서 강한 지시("비중 높여라")를 주면 낡은 편향을 고착시킨다.
  // 반대로 아예 버리면 유일한 성과 신호까지 잃으니, '참고만' 수준으로 남긴다.
  // 표본 부족(<INSIGHTS_MIN_SAMPLE)·표본수 미상도 같은 이유로 weak.
  const strength = (stale || sample_size < INSIGHTS_MIN_SAMPLE) ? 'weak' : 'full';

  const ins = { top_domains, bottom_domains, top_angle, title_patterns, title_length, guidance, sample_size, generated_at, ageDays, stale, strength };
  logger.info(`인사이트 주입(${strength}): top=[${top_domains.join('|')}] bottom=[${bottom_domains.join('|')}] angle=${top_angle || '-'} patterns=${title_patterns.length} guidance=${guidance.length} 표본=${sample_size || '?'} 나이=${ageDays === null ? '?' : ageDays}일`);
  return ins;
}

/** 표본·집계시점 라벨 — 근거 없는 단정을 막기 위해 프롬프트에 항상 함께 넣는다. */
export function insightsMetaLabel(ins) {
  const sample = ins.sample_size ? `표본 ${ins.sample_size}편` : '표본수 미상';
  const age = ins.ageDays === null ? '집계시점 미상' : `${ins.ageDays}일 전 집계`;
  return `${sample}, ${age}`;
}

/** 성과 인사이트 → 주제 발굴 프롬프트용 지시문 블록. ins 없으면 빈 문자열(무주입). */
export function insightsBacklogBlock(ins) {
  if (!ins || typeof ins !== 'object') return '';
  // 배열 필드는 loadInsights 가 보장하지만, 손으로 만든 ins 가 들어와도 throw 하지 않도록 방어.
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []);
  const top = arr(ins.top_domains), bottom = arr(ins.bottom_domains);
  const patterns = arr(ins.title_patterns), guidance = arr(ins.guidance);
  const lines = [];
  if (top.length) lines.push(`- 평균 대비 **성과 우수** 도메인: ${top.join(', ')}`);
  if (bottom.length) lines.push(`- 평균 대비 **부진** 도메인: ${bottom.join(', ')}`);
  if (ins.top_angle) lines.push(`- 성과 우수 앵글: ${ins.top_angle}`);
  if (patterns.length) lines.push(`- 성과 우수 제목/훅 패턴: ${patterns.join(' / ')}`);
  if (ins.title_length) lines.push(`- 성과 최고 제목 길이 구간: ${ins.title_length}자 → subject 를 이 길이에 맞춰라`);
  for (const g of guidance) lines.push(`- ${g}`);   // evolve 가 써 준 문장 원문
  if (!lines.length) return '';
  const directive = ins.strength === 'full'
    ? `이번 배치는 **우수 도메인 비중을 높이고 부진 도메인은 줄여라**. 단 한 도메인이 배치의 ${INSIGHTS_TOP_DOMAIN_CAP_PCT}%를 넘지 않게 하고, 부진 도메인도 0개로 만들지 마라(최소 1개 유지) — 성과 좋은 도메인만 뽑으면 채널이 단조로워져 오히려 이탈이 늘고 학습이 국소최적에 갇힌다.`
    : `데이터 신뢰도가 낮다(위 표본·집계시점 확인) → **약한 참고만** 하라. 우수 도메인을 살짝 우대하는 정도로 그치고 도메인 다양성을 우선하라.`;
  return `[최근 유튜브 성과 데이터 — ${insightsMetaLabel(ins)}]
${lines.join('\n')}

${directive}
위 데이터는 관찰된 경향일 뿐 법칙이 아니다 — 표본이 작으면 확신하지 말고, 주제 자체의 힘을 먼저 봐라.`;
}

/**
 * 닳고 닳은 인터넷 클리셰 — 실제 관심이 아니라 "잡학 퀴즈" 느낌이라 제외.
 * 프롬프트에 넣어 raccoon 이 이런 결을 피하게 강제한다(사용자 피드백 2026-07-14).
 */
const CLICHES = [
  '금붕어 기억력', '바이킹 뿔투구', '만리장성 우주에서', '혀 맛지도', '유리는 액체',
  '나폴레옹 키/단신', '박쥐는 눈이', '좌뇌 우뇌', '토성은 물에', '카멜레온 색',
  '인간은 뇌의 10%', '피는 파랗다', '금성/화성 밝기', '다이아몬드는 석탄',
];

/** 채널이 노리는 "실제로 사람들이 빠져드는" 결 — 단순 상식교정에서 확장(사용자 피드백). */
const GENRES = [
  '몸·건강에 직접 닿는 사실(내 몸에서 실제로 벌어지는 일)',
  '돈·소비의 숨은 진실(사람들이 손해보는 지점)',
  '관계·심리의 반직관(왜 우리가 그렇게 행동하는가)',
  '일상 사물·습관의 소름 돋는 기원/유래',
  '"왜 이런 거지?" 한 번도 안 물어본 일상의 메커니즘',
  '충격적 실화·사건(사람의 드라마가 있는 사실)',
];

/** 재구성/발굴 공통 규칙 블록. ins=성과 인사이트(없으면 무주입 — 기존 프롬프트와 동일). */
function rulesBlock(cfg, existingSubjects, ins) {
  const domains = (cfg.channel?.domains || []).join(', ');
  const avoid = existingSubjects.slice(0, 80).map(s => `- ${s}`).join('\n') || '(없음)';
  const perf = insightsBacklogBlock(ins);
  return `${perf ? perf + '\n\n' : ''}[반드시]
- **실제 사실**만(도시전설·미확인·과장 금지 — badger가 거르지만 raw부터 사실 지향).
- **닳은 클리셰 금지**: ${CLICHES.join(', ')} 같은 "인터넷에서 백 번 본 잡학" 결은 제외.
- **실제 사람이 궁금해하는 것**: "그래서 나랑 무슨 상관?"이 아니라, 몸·돈·관계·일상처럼 이해관계가 걸리거나 서사(드라마)가 있는 사실 우선.
- 아래 장르로 다양하게(상식 반전에만 갇히지 말 것): ${GENRES.join(' / ')}.
- 도메인 태그: ${domains} 중 택1(안 맞으면 가까운 것).
- [이미 있는 주제]와 겹치지 마라.

[이미 있는 주제]
${avoid}

[각 원소 스키마]
{ "subject": 짧은 주제(한국어 한 줄), "common_belief": 사람들이 흔히 믿거나 기대하는 것(서사형이면 "설마 이게 진짜?" 식 통념), "reveal": 놀라운 실제 사실(한 줄), "domain": 도메인, "source_hint": 확인 가능한 근거(기관·인물·사건명, 한국어 가능) }`;
}

/** 실제 인기 검증된 Reddit 씨앗을 한국어 "설마 진짜?" 카드 소재로 재구성. */
export function buildReframePrompt(cfg, existingSubjects, seeds, n, ins) {
  const persona = loadAgentBrief('raccoon');
  const list = seeds.map((s, i) => `${i + 1}. (r/${s.subreddit}) ${s.fact}`).join('\n');
  return `${persona ? persona + '\n\n' : ''}아래는 Reddit 의 "흥미로운 사실" 커뮤니티에서 **실제로 수천~수만 표를 받아 인기가 검증된** 사실들이다(영어). 한국 쇼츠 시청자에게도 통할 것을 골라 **${n}개**를 한국어 "설마 진짜?" 카드 소재로 재구성하라.

${rulesBlock(cfg, existingSubjects, ins)}

[재구성 지침]
- 영어 원문의 **사실은 그대로 유지**(왜곡·과장 금지), 한국어로 자연스럽게. 한국 맥락에 안 통하거나 너무 지엽적인 건 버려라.
- source_hint 에는 그 사실의 **실제 출처**(인물·사건·기관)를 적어라(Reddit 자체가 아니라).
- 첫 3초 훅이 강한 것 우선(드라마·이해관계·반전이 큰 것).

[Reddit 인기 사실 후보]
${list}

설명 없이 JSON 배열만 출력(정확히 ${n}개 이내).`;
}

/** 씨앗이 부족하거나 보강용 — 장르 확장된 오리지널 아이디어 발굴. */
export function buildPrompt(cfg, existingSubjects, n, ins) {
  const persona = loadAgentBrief('raccoon');
  return `${persona ? persona + '\n\n' : ''}스크롤하다 손가락을 멈추게 하는, **실제로 사람들이 궁금해하는 놀라운 사실** ${n}개를 발굴하라. 단순 상식 퀴즈가 아니라 이해관계·서사가 있는 것.

${rulesBlock(cfg, existingSubjects, ins)}

설명 없이 JSON 배열만 출력.`;
}

/** "만약 ~였다면?" 카운터팩추얼 앵글 — 전 연령 보편 호기심(사용자 요청 2026-07-14). */
const WHATIF_GENRES = [
  '역사 가정("만약 고대 로마에 스마트폰/인터넷이 있었다면?", "만약 그 전쟁이 반대로 끝났다면?")',
  '인체·생리 극한("만약 인간이 100년 동안 잠을 안 잔다면?", "만약 심장이 멈춰도 뇌가 깨어있다면?")',
  '시간여행·인물("역사 속 인물이 현대에 온다면?", "만약 아인슈타인이 스마트폰을 봤다면?")',
  '스케일 전환("만약 지구 자전이 2배 빨라진다면?", "만약 모든 곤충이 사라진다면?")',
  '일상 규칙 붕괴("만약 돈이 내일 사라진다면?", "만약 잠이 필요 없어진다면?")',
];

/** what-if(가상 추론) 아이디어 발굴. 실제 사실 폭로가 아니라 '실제 근거로 지탱되는 사고실험'. */
export function buildWhatIfPrompt(cfg, existingSubjects, n, ins) {
  const persona = loadAgentBrief('raccoon');
  const domains = (cfg.channel?.domains || []).join(', ');
  const avoid = existingSubjects.slice(0, 80).map(s => `- ${s}`).join('\n') || '(없음)';
  const perf = insightsBacklogBlock(ins);
  return `${persona ? persona + '\n\n' : ''}누구나 한 번쯤 상상해본 **"만약 ~였다면 어떻게 됐을까?"** 형식의, 14살도 40살도 클릭하는 보편 호기심 소재 ${n}개를 발굴하라. 이건 사실 폭로가 아니라 **실제 근거로 따져보는 사고실험**이다.

${perf ? perf + '\n\n' : ''}[반드시]
- **전제는 흥미롭고 보편적**: 전 연령이 "어 그거 궁금했는데" 하고 클릭할 것. 아래 결로 다양하게: ${WHATIF_GENRES.join(' / ')}.
- **추론(결말)은 반드시 실제 사실·물리·역사·생리 제약으로 지탱**하라 — 근거 없는 판타지·초자연 금지(badger가 거른다). "그럴듯하게 진짜 그렇게 됐을 법한" 결말이어야 힘이 있다.
- **사실 폭로가 아님**: 단정("~이다") 말고 근거 기반 추론("~였을 것이다") 톤. 단, 추론을 지탱하는 앵커(source_hint)는 실제여야 한다.
- 뻔한 결말 금지(예: "다 죽는다"만으로 끝내지 말고 의외의 2차 효과·반전을 담아라).
- 도메인 태그: ${domains} 중 택1.
- [이미 있는 주제]와 겹치지 마라.

[이미 있는 주제]
${avoid}

[각 원소 스키마]
{ "subject": "만약 ~였다면?" 형식 한 줄(호기심 훅),
  "common_belief": 사람들이 순진하게 상상하는 방향(흔한 기대),
  "reveal": 실제 근거로 따져본 의외의 결말/2차효과(한 줄, 추론),
  "source_hint": 그 추론을 지탱하는 실제 사실·제약(인물·물리법칙·역사·생리 — 실재해야 함),
  "domain": 도메인,
  "angle": "whatif" }

설명 없이 JSON 배열만 출력(정확히 ${n}개 이내).`;
}

/** claude 응답(JSON 배열) → 정규화된 백로그 항목들. seen 갱신. angle=스테이지 앵글(기본 reveal). */
function ingest(text, { seen, origin, angle = 'reveal' }) {
  let arr;
  try { arr = extractJson(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const fresh = [];
  for (const it of arr) {
    if (!it || typeof it.subject !== 'string' || typeof it.reveal !== 'string') continue;
    const id = idOf(it.subject);
    if (seen.has(id)) continue;
    seen.add(id);
    // angle: 스테이지가 authoritative(whatif 스테이지=whatif), 아니면 항목 자체 표기, 기본 reveal.
    const itemAngle = it.angle === 'whatif' || angle === 'whatif' ? 'whatif' : 'reveal';
    fresh.push({
      id, subject: it.subject.trim(),
      common_belief: String(it.common_belief || '').trim(),
      reveal: it.reveal.trim(),
      domain: String(it.domain || '').trim(),
      source_hint: String(it.source_hint || '').trim(),
      angle: itemAngle,                        // 'reveal'(설마 진짜?) | 'whatif'(만약 ~였다면?)
      origin,                                  // 'reddit' | 'llm' — 실제 인기 검증 출처 추적
      created_at: new Date().toISOString(),
    });
  }
  return fresh;
}

export async function refillBacklog({ n } = {}) {
  const cfg = loadConfig();
  n = n || cfg.backlog?.refill_batch || 10;
  const existing = loadBacklog();
  const seen = new Set(existing.map(x => x.id));
  const subjects = existing.map(x => x.subject);

  // 자가발전 폐루프: evolve 가 남긴 성과 인사이트를 발굴 프롬프트에 주입(없으면 무주입).
  // 로드 자체가 주입 여부·항목·표본수를 로그에 남긴다(사후 "그날 뭘 학습했나" 추적용).
  const ins = loadInsights();
  if (!ins) log.info('성과 인사이트 없음 → 기존 발굴 프롬프트로 진행(무주입)');

  // '만약 ~였다면?'(whatif) 슬롯 먼저 카브아웃 — whatif 는 실사실이 아니라 오리지널(LLM) 사고실험.
  const whatifRatio = Math.min(1, Math.max(0, cfg.backlog?.angles?.whatif_ratio ?? 0)); // [0,1] 클램프(오설정 방지)
  const nWhatif = Math.round(n * whatifRatio);
  const nReveal = n - nWhatif;   // 나머지는 '설마 진짜?'(reveal) — reddit+오리지널

  // 실제 인기 검증 씨앗(Reddit) 비율 — reveal 몫에만 적용(나머지는 장르확장 오리지널).
  const ratio = cfg.backlog?.reddit_seed?.seed_ratio ?? 0.7;
  let nSeed = Math.round(nReveal * ratio);
  const fresh = [];

  // ① Reddit 씨앗 재구성(실패/빈결과여도 계속 — 오리지널로 보강)
  if (nSeed > 0) {
    let seeds = [];
    try { seeds = await collectSeeds(cfg); } catch (e) { log.warn(`Reddit 씨앗 수집 실패(계속): ${e.message}`); }
    if (seeds.length) {
      const text = callClaude(buildReframePrompt(cfg, subjects, seeds.slice(0, 30), nSeed, ins));
      const got = ingest(text, { seen, origin: 'reddit' });
      fresh.push(...got);
      log.info(`Reddit 재구성: +${got.length}`);
    } else {
      log.warn('Reddit 씨앗 0건 → 전량 오리지널로 대체');
    }
  }

  // ② 오리지널 장르확장(reveal)으로 reveal 몫 채우기
  const nOrig = nReveal - fresh.length;
  if (nOrig > 0) {
    const text = callClaude(buildPrompt(cfg, [...subjects, ...fresh.map(x => x.subject)], nOrig, ins));
    const got = ingest(text, { seen, origin: 'llm' });
    fresh.push(...got);
    log.info(`오리지널 발굴: +${got.length}`);
  }

  // ③ '만약 ~였다면?'(whatif) 발굴 — 근거 기반 사고실험(사용자 요청 2026-07-14)
  if (nWhatif > 0) {
    const text = callClaude(buildWhatIfPrompt(cfg, [...subjects, ...fresh.map(x => x.subject)], nWhatif, ins));
    const got = ingest(text, { seen, origin: 'llm', angle: 'whatif' });
    fresh.push(...got);
    log.info(`what-if 발굴: +${got.length}`);
  }

  appendBacklog(fresh);
  return {
    added: fresh.length,
    total: existing.length + fresh.length,
    reddit: fresh.filter(x => x.origin === 'reddit').length,
    whatif: fresh.filter(x => x.angle === 'whatif').length,
    // 사후 추적용(추가 필드 — 기존 {ok, added, total} 계약은 유지). null=인사이트 무주입.
    insights_applied: ins ? { strength: ins.strength, sample_size: ins.sample_size, age_days: ins.ageDays } : null,
  };
}

async function main() {
  const nArg = process.argv.indexOf('--n');
  const n = nArg > -1 ? parseInt(process.argv[nArg + 1], 10) : undefined;
  try {
    const r = await refillBacklog({ n });
    log.info(`백로그 보충: +${r.added} (총 ${r.total})`);
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    log.error(`백로그 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
