#!/usr/bin/env node
/**
 * cardnews/backlog.mjs — Heron 🪶 소재 백로그 보충 (계획 §3.3, AC-2)
 *
 * 사용: node scripts/cardnews/backlog.mjs [--n 10]
 * 계약: stdout JSON `{ok, added, total}`. exit 0 / 2=오류
 *
 * 구독 claude 로 "고전문학의 문장으로 건네는 위로" 후보를 **경량 메타**로 생성해 백로그에
 * append 한다. 풀 대본·이미지는 만들지 않는다 — 하루 1건만 제작되므로 40건을 미리 만드는 건
 * 순수 낭비다.
 *
 * 🔴 **버티컬 전환(2026-07-31)**: 세계 문화·나라별 차이 → 고전문학 인용 위로.
 * 옛 스키마(`subject·country·domain·common_practice·contrast·consequence·trigger_situation·
 * misconception`)는 `*.worldculture.bak` 에 보존돼 있다. 엔진은 손대지 않았고 이 파일이
 * 담당하는 콘텐츠 레이어만 갈렸다.
 *
 * 🔴 **이 채널에서 가장 현실적인 사고는 가짜 인용이다.** 인터넷에는 그 책에 없는데 그 책 것으로
 * 떠도는 문장이 대량으로 있고, LLM 은 출처까지 그럴듯하게 붙여 뱉는다. 그래서 소재는
 * `source.fulltext_url`(원문 전문 주소)을 **필수**로 들고 온다 — factcheck 가 그 파일을 받아
 * `quote_original` 을 글자 단위로 대조하고, 없으면 그날로 폐기한다. 프롬프트로 부탁하는 것이
 * 아니라 기계가 확인하는 구조다.
 *
 * ⚠ **원문 대조의 한계는 곧 소재의 한계다**(알려진 제약):
 *   - 실질적으로 대조 가능한 소스는 **구텐베르크 plain text**뿐이라 소재가 영미권으로 기운다.
 *   - 비영어 원작(톨스토이·도스토옙스키)은 구텐베르크의 **영역본**이 대조 대상이 된다. 즉 우리가
 *     옮기는 것은 "원문의 번역의 번역"이고, 그 영역본 자체의 퍼블릭 도메인 여부(1929년 이전
 *     출판·역자 사후 70년)는 **기계가 확인하지 못한다**. 지금은 구텐베르크에 올라와 있다는
 *     사실을 근거로 삼는다.
 *   - 한국·중국·일본 고전(나쓰메 소세키·루쉰)은 구텐베르크에 원문이 없어 사실상 배제된다.
 *     Aozora·Wikisource 는 plain text 가 아니라 별도 어댑터가 필요하다(v1.1 후보).
 */
import { createHash } from 'node:crypto';
import { makeLogger } from '../lib/log.mjs';
import {
  loadConfig, loadBacklog, appendBacklog, callClaude, extractJson, isMainModule, withBrief,
} from './lib.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('cardnews/backlog');

/** 백로그 id — `problem` sha1 10자. post_id 의 꼬리가 된다(옛 버티컬의 subject 자리). */
export const idOf = (problem) => createHash('sha1').update(String(problem).trim()).digest('hex').slice(0, 10);

/**
 * 필수 문자열 필드 — 하나라도 비면 그 항목은 버린다.
 *
 * 🔴 **프롬프트로 요구만 하고 여기서 안 막으면 실패가 조용해진다.** 이전 버티컬에서 실측된
 * 실패다 — 모델이 빼먹은 항목이 그대로 백로그에 앉고, 채점자는 구분할 수 없고, 작가는 쓸
 * 재료가 없어 밋밋한 쪽으로 돌아간다. 재고 목표가 40건(5일치 여유)이라 한 번의 보충이
 * 얇아져도 결방이 되지 않는다. 그러니 **의심스러우면 버리는 쪽**이 싸다.
 */
export const REQUIRED = ['problem', 'situation', 'quote_original', 'quote_ko', 'interpretation', 'shift', 'audience'];

/** 출처 필수 3종. `translator` 는 값이 아니라 **키의 존재**로 판정한다(아래 주석 참조). */
/** 문제 축 화이트리스트 — config `channel.problem_axes` 를 읽되, 설정이 비면 빈 배열(=축 없음). */
export const AXES = (() => {
  try { return loadConfig()?.channel?.problem_axes ?? []; } catch { return []; }
})();

export const REQUIRED_SOURCE = ['title', 'author', 'fulltext_url'];

/** 🔴 시는 스키마 수준에서 존재하지 않는다 — `poem` 은 여기 없다(config `quote.allowed_forms`). */
export const DEFAULT_FORMS = ['novel', 'essay', 'nonfiction'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 대조 소스 화이트리스트 판정 — 모델이 지어낸 URL 로 검증을 우회하지 못하게 한다. */
export function isAllowedFulltextUrl(url, cfg = {}) {
  const hosts = cfg?.quote?.fulltext_hosts || ['gutenberg.org', 'www.gutenberg.org'];
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return hosts.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

/**
 * 인용 종속성 — 해설이 인용보다 충분히 길어야 정당한 인용이 된다(저작권법 28조 "정당한 범위").
 * 임계는 `quote.min_interpretation_ratio` 하나에서 온다 — 인용 게이트와 같은 값을 읽어야
 * "백로그는 통과했는데 게이트가 막는" 드리프트가 생기지 않는다.
 */
export function interpretationLongEnough(item, cfg = {}) {
  const ratio = Number(cfg?.quote?.min_interpretation_ratio ?? 1.5);
  const q = str(item?.quote_ko).length;
  const i = str(item?.interpretation).length;
  return q > 0 && i >= q * ratio;
}

/**
 * 읽는 쪽 판정 — 이 항목이 **검증 가능한 인용**을 실제로 들고 있는가.
 * 옛 재고(세계 문화 스키마)를 throw 시키지 않고 구분만 한다(`hasStakes` 의 자리).
 */
export function hasQuoteSource(item) {
  if (!item || typeof item !== 'object') return false;
  if (!str(item.quote_original) || !str(item.quote_ko)) return false;
  return REQUIRED_SOURCE.every(k => str(item.source?.[k]));
}

/**
 * 발굴 프롬프트. **반드시 페르소나로 시작한다** — `withBrief` 가 BRIEF 블록을 선두에 붙인다.
 * @param {object} cfg
 * @param {string[]} existingProblems 중복 회피용 기존 문제
 * @param {number} n
 */
export function buildBacklogPrompt(cfg, existingProblems = [], n = 10) {
  const axes = (cfg?.channel?.problem_axes || []).join(' / ')
    || '연애·이별 / 인간관계·거리 / 자기 자신과의 관계 / 일과 소진 / 상실·애도';
  const forms = (cfg?.quote?.allowed_forms || DEFAULT_FORMS).join(' | ');
  const maxQ = cfg?.quote?.max_chars ?? 120;
  const ratio = cfg?.quote?.min_interpretation_ratio ?? 1.5;
  const hosts = (cfg?.quote?.fulltext_hosts || ['gutenberg.org']).join(', ');
  const avoid = existingProblems.slice(-60).map(s => `- ${s}`).join('\n') || '(없음)';
  return withBrief('heron', `"${cfg?.channel?.vertical || '고전문학의 문장으로 건네는 위로'}" 인스타 카드뉴스 소재 후보를 **${n}개** 발굴하라.

[절대 규칙 — 어기면 전건 폐기]
- **지어내지 마라.** 없는 구절을 그럴듯한 출처와 함께 만드는 것이 이 채널에서 가장 크고 가장 흔한 사고다.
  기억이 또렷하다는 느낌은 근거가 아니다 — 너는 명언 모음 사이트에서 재생산된 가짜 인용도 함께 학습했다.
  확신이 서지 않으면 **그 후보를 내지 마라.** 우리는 한 편을 거르는 대가로 계정을 지킨다.
- **저작권 만료 고전만.** 현대 작품은 제외한다(톨스토이·도스토옙스키·오스틴·디킨스·브론테·카프카 같은).
- **시(詩) 금지.** form 은 ${forms} 뿐이고 poem 은 아예 존재하지 않는다. 시는 짧아서 두세 줄만 인용해도
  작품의 상당 부분이 되어 정당한 인용의 범위를 넘긴다.
- **인용은 한두 문장.** quote_ko 는 ${maxQ}자 이내다. 길게 끊어 오면 그 후보는 인용 게이트에서 막힌다.
- **출처 3종 필수** — 제목·저자·원문 전문 주소(fulltext_url). 하나라도 없으면 폐기다.
- **번역은 네가 원문에서 직접 옮겨라.** 기존 번역서의 문장을 가져오지 마라 — 원작의 저작권이 끝나도
  번역자의 저작권은 따로 살아 있다. 그래서 translator 는 **항상 null** 이다.

[🔴 원문 대조 — 이 후보가 살아남는 유일한 길]
제출한 quote_original 은 기계가 fulltext_url 의 **원문 전문을 통째로 내려받아** 글자 단위로 대조한다.
구두점·대소문자·줄바꿈은 무시하지만, **문장 자체가 다르면 즉시 폐기**된다(의역·기억 재구성·요약 전부 걸린다).
- fulltext_url 은 원문 전문을 그대로 주는 주소여야 한다. 허용 호스트: ${hosts}
  예) https://www.gutenberg.org/cache/epub/1342/pg1342.txt
- quote_original 은 그 파일에 **있는 그대로**의 문장이다. 원문이 영어면 영어로 적어라(한국어로 옮기지 말고).
- quote_ko 는 그 원문을 네가 직접 옮긴 한국어다. 카드에 나가는 것은 이쪽이다.
- 원문을 구할 수 없는 작품은 **후보에서 빼라.** 대조에 실패하면 그날 발행이 통째로 날아간다.

[문제 축 — 연애·인간관계에서 시작하되 거기 갇히지 마라]
${axes}
자기 자신과의 관계, 일과 소진, 상실도 같은 무게로 다뤄라. problem 은 표지 한 줄이 될 만큼 구체적이어야
한다: "사랑받지 못할까 봐"(✗) / "내가 너무 많이 준 것 같을 때"(○).
[이미 있는 문제]와 겹치지 마라.

[이미 있는 문제]
${avoid}

[🔴 구절이 그 문제를 **실제로** 다뤄야 한다]
분위기가 비슷한 문장을 갖다 붙이는 것이 이 채널이 실패하는 두 번째 방식이다. 그 구절이 놓인 자리에서
작가가 다루고 있던 것이 이 문제여야 한다. 해설(interpretation)은 인용보다 길어야 하고(최소 ${ratio}배),
"그 구절이 지금 이 상황에서 무슨 뜻인지"를 **우리 말로** 푼다 — 원문을 흉내 낸 번역체가 아니라 오늘의 말로.
shift 는 관점이 실제로 뒤집히는 지점이다: "더 노력하라"가 아니라 **"그건 노력의 문제가 아니었다"** 쪽으로.

[각 원소 스키마]
{ "problem": 겪는 문제 — 표지가 될 한 줄(24자 이내 권장),
  "axis": 아래 축 중 **정확히 하나**를 그대로 적는다 — ${AXES.join(" / ")},
  "situation": 구체적 장면 — 읽는 사람이 자기를 대입할 지점 한 줄,
  "quote_original": 원문 그대로의 한두 문장(대조 대상),
  "quote_ko": 그 원문을 직접 옮긴 한국어(${maxQ}자 이내, 카드에 표시되는 것),
  "source": { "title": 작품 제목, "author": 저자, "translator": null, "year": 발표 연도(숫자),
              "fulltext_url": 원문 전문 주소 },
  "form": ${forms.split(' | ').map(f => `"${f}"`).join(' 또는 ')} 중 하나,
  "interpretation": 그 구절이 이 상황에서 무슨 뜻인지 — 우리 해설(인용보다 길게),
  "shift": 관점이 어떻게 뒤집히는지 한 줄,
  "audience": 이 카드를 보낼 만한 사람 한 줄,
  "public_domain": true }

설명 없이 JSON 배열만 출력(정확히 ${n}개 이내).`);
}

/**
 * claude 응답(JSON 배열) → 정규화된 백로그 항목. `seen` 을 갱신하며 중복을 제거한다.
 * 파싱 실패·비배열은 **빈 배열**(런을 죽이지 않는다 — 보충 실패는 재고로 버틴다).
 */
export function ingest(text, { seen = new Set(), now = new Date(), cfg = {} } = {}) {
  let arr;
  try { arr = extractJson(text); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const forms = cfg?.quote?.allowed_forms || DEFAULT_FORMS;
  const fresh = [];
  const dropped = { missing: 0, dup: 0, shape: 0, source: 0, form: 0, url: 0, ratio: 0, translated: 0 };

  for (const it of arr) {
    if (!it || typeof it !== 'object') { dropped.shape++; continue; }
    if (REQUIRED.some(k => !str(it[k]))) { dropped.missing++; continue; }
    if (REQUIRED_SOURCE.some(k => !str(it.source?.[k]))) { dropped.source++; continue; }
    // 🔴 form: 화이트리스트 밖(특히 poem)은 폐기. 프롬프트에서 금지하고 여기서 다시 막는다 —
    //    저작권 판단을 모델의 준수에 걸어 두지 않는다.
    if (!forms.includes(str(it.form))) { dropped.form++; continue; }
    if (!isAllowedFulltextUrl(it.source.fulltext_url, cfg)) { dropped.url++; continue; }
    // 🔴 기존 번역서를 가져온 정황 — translator 에 사람 이름이 붙어 있으면 그건 우리 번역이
    //    아니다(원작이 만료돼도 번역자 저작권은 따로 산다). 값이 아니라 **정황**으로 막는다.
    if (str(it.source.translator)) { dropped.translated++; continue; }
    if (!interpretationLongEnough(it, cfg)) { dropped.ratio++; continue; }

    const id = idOf(it.problem);
    if (seen.has(id)) { dropped.dup++; continue; }
    seen.add(id);

    const problem = str(it.problem);
    fresh.push({
      id,
      problem,
      // 🔴 엔진 호환 슬롯. `run-cardnews.mjs`(무수정 대상)와 인덱스·유사재탕 차단이 `subject`
      //    키를 읽는다. 이 채널에서 그 자리는 problem 이다 — 값을 둘로 갈라 두면 dedup 이
      //    조용히 반쪽만 돌기 때문에 **미러링**으로 붙여 둔다(파생값이지 별도 입력이 아니다).
      subject: problem,
      situation: str(it.situation),
      // 문제 축 — 설정의 `channel.problem_axes` 중 하나. pick 의 회전과 배경 장면 선택이 이 값을
      // 쓴다. 모델이 축 밖의 말을 적을 수 있으므로 화이트리스트 밖이면 null 로 떨어뜨린다
      // (없으면 배경은 기본 장면, 회전은 problem 문자열로 폴백 — 둘 다 죽지 않는다).
      axis: AXES.includes(str(it.axis)) ? str(it.axis) : null,
      quote_original: str(it.quote_original),
      quote_ko: str(it.quote_ko),
      source: {
        title: str(it.source.title),
        author: str(it.source.author),
        // 🔴 **항상 null.** 키 누락과 구분되게 명시한다 — 우리는 원문에서 직접 옮기므로
        //    번역자 저작권이 개입할 자리가 없고, 게이트는 이 둘을 다르게 판정한다.
        translator: null,
        year: Number.isFinite(Number(it.source.year)) ? Number(it.source.year) : null,
        fulltext_url: str(it.source.fulltext_url),
      },
      form: str(it.form),
      interpretation: str(it.interpretation),
      shift: str(it.shift),
      audience: str(it.audience),
      public_domain: it.public_domain !== false,
      created_at: now.toISOString(),
    });
  }

  // 폐기는 조용하면 안 된다 — added:0 만 보면 "모델이 안 돌았나"와 "스키마를 못 채웠나"가
  // 구분되지 않고, 후자는 프롬프트를 고쳐야 할 신호다.
  const noisy = Object.entries(dropped).filter(([, v]) => v > 0 && v !== dropped.dup);
  if (noisy.length) log.warn(`후보 폐기: ${noisy.map(([k, v]) => `${k} ${v}건`).join(' · ')}`);
  return fresh;
}

/**
 * 백로그 보충.
 * @param {object} [opt]
 * @param {number} [opt.n] 생성 개수(기본 `backlog.refill_batch`)
 * @param {object} [opt.deps] `{callClaude}` — 테스트 주입점. 기본은 실 CLI 경로.
 * @param {boolean} [opt.exempt] 예산 throw 면제(buffer top-up 경로에서만)
 */
export function refillBacklog({ n, cfg = null, deps = {}, exempt = false } = {}) {
  const conf = cfg || loadConfig();
  const call = deps.callClaude || callClaude;
  const count = Number.isFinite(n) && n > 0 ? n : (conf.backlog?.refill_batch || 10);

  const existing = loadBacklog();
  const seen = new Set(existing.map(x => x.id));
  const prompt = buildBacklogPrompt(conf, existing.map(x => x.problem || x.subject).filter(Boolean), count);

  const text = call(prompt, { cfg: conf, exempt });
  const fresh = ingest(text, { seen, cfg: conf });
  if (fresh.length) appendBacklog(fresh);

  log.info(`백로그 보충: +${fresh.length}건 (요청 ${count} · 총 ${existing.length + fresh.length}건)`);
  return { ok: true, added: fresh.length, total: existing.length + fresh.length, items: fresh };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--n');
  const n = i >= 0 ? parseInt(argv[i + 1], 10) : undefined;
  try {
    const r = refillBacklog({ n: Number.isFinite(n) ? n : undefined });
    process.stdout.write(JSON.stringify({ ok: true, added: r.added, total: r.total }) + '\n');
    process.exit(0);
  } catch (e) {
    log.error(`백로그 보충 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, diag: e.diag || null }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
