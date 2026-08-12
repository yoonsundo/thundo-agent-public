/**
 * cardnews/imagen.mjs — 카드 배경 AI 이미지 (shorts/imagen.mjs 재사용 래퍼)
 *
 * 평평한 파란 그라데이션 카드가 "너무 구리다"는 지적의 해법. 쇼츠 파이프라인이 같은 문제
 * ("단조로운 그라데이션")를 이미 Vertex AI `gemini-2.5-flash-image` 로 풀었으므로 **그 모듈을
 * 그대로 호출**한다 — `scripts/shorts/imagen.mjs` 는 한 줄도 고치지 않는다(Tier A zero-diff).
 *
 * ⚠ 응답은 `aspect_ratio` 와 무관하게 **1024×1024 정사각**이다(그 필드는 프롬프트 텍스트로만
 * 들어간다). 쇼츠는 ffmpeg 로 커버크롭하고, 카드뉴스는 CSS `background-size:cover` 로
 * 브라우저에게 1080×1350 커버크롭을 시킨다(render.mjs) — 이미지 라이브러리·신규 의존성 0개.
 *
 * ⚠ 비용 설계: **글 1편당 이미지 1장**(표지 주제로 뽑아 7장에 공유). 카드마다 다른 사진 7장은
 * 스톡사진 콜라주처럼 보여 디자인상으로도 나쁘고 7배 비싸다(~$0.21 vs ~$0.03). 본문 카드는
 * 같은 배경에 **더 진한 스크림 + 약한 블러**를 걸어 한 세트로 읽히게 한다. 카드별 생성은
 * `cfg.imagen.per_card=true` 한 줄로 켜진다.
 *
 * ⛔ 이 모듈은 **절대 throw 하지 않는다**. 실패는 전부 `{ok:false, reason}` 이고 호출자는
 *    기존 그라데이션으로 폴백한다 — 배경 생성 때문에 발행이 멈추면 안 된다.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `shorts/imagen.mjs:90` 과 같은 판정. 한 줄을 복제한 이유는 **정적 import 를 피하기 위해서**다 —
 * 그쪽을 static 으로 끌어오면 imagen 이 꺼져 있는 렌더에서도 google-auth-library 가 로드된다.
 * 실제 생성 함수는 필요한 순간에만 dynamic import 한다(꺼진 경로엔 네트워크 코드가 아예 없다).
 */
export function imagenEnabled(cfg) {
  return !!(cfg && cfg.imagen && cfg.imagen.enabled);
}

/**
 * 한글 국명 → 영문. ICU(`Intl.DisplayNames`) 를 역인덱스해 264개국을 표 없이 얻는다.
 * `config/cardnews-countries.txt` 의 별칭·구표기 중 ICU 표준명과 다른 11개만 손으로 보정한다.
 */
const COUNTRY_ALIAS = Object.freeze({
  '한국': 'South Korea', '남한': 'South Korea', '미합중국': 'United States',
  '홍콩': 'Hong Kong', '사우디': 'Saudi Arabia', 'UAE': 'United Arab Emirates',
  '터키': 'Türkiye', '남아공': 'South Africa', '남아프리카공화국': 'South Africa',
  '잉글랜드': 'England', '호주': 'Australia',
});

let _ko2en = null;
function koToEn() {
  if (_ko2en) return _ko2en;
  const m = new Map();
  try {
    const ko = new Intl.DisplayNames(['ko'], { type: 'region' });
    const en = new Intl.DisplayNames(['en'], { type: 'region' });
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A) for (const b of A) {
      const code = a + b;
      let k, e;
      try { k = ko.of(code); e = en.of(code); } catch { continue; }
      if (!k || k === code || !e || e === code) continue;
      if (!m.has(k)) m.set(k, e);
    }
  } catch { /* ICU 축소 빌드 — 별칭 표만으로 동작 */ }
  _ko2en = m;
  return m;
}

/** 한글 국명 → 영문명. 못 찾으면 입력 그대로(프롬프트가 비는 것보다 낫다). */
export function countryEnglish(ko) {
  const k = String(ko ?? '').trim();
  if (!k) return '';
  return COUNTRY_ALIAS[k] || koToEn().get(k) || k;
}

/**
 * 도메인 → 영어 장면 어휘. `config/cardnews.json channel.domains` 10종과 1:1.
 *
 * 카드 문안은 한국어라 번역 없이는 영어 프롬프트로 못 옮긴다. 그래서 **주장(claim)이 아니라
 * 도메인**을 장면으로 번역한다 — 요구사항인 "주장을 문자 그대로 그리지 않고 나라·주제를
 * 환기"와 정확히 맞아떨어진다(가령 "밥그릇을 든다"를 그리면 사실주장 삽화가 되어 버린다).
 */
const DOMAIN_SCENES = Object.freeze({
  '식사예절': 'a set dining table with ceramic bowls and worn utensils in a quiet restaurant interior',
  '인사·호칭': 'the threshold and doorway of an old building, curtains moving in soft afternoon light',
  '선물·금기': 'wrapped parcels and loose ribbon resting on a scuffed wooden surface',
  '시간관념': 'a weathered public clock above an empty platform at dusk',
  '주거·생활': 'a narrow residential alley of low houses in the blue hour',
  '교육': 'an empty classroom of wooden desks with late afternoon light across the floor',
  '직장문화': 'an empty office corridor of glass partitions late at night',
  '축제·의례': 'paper lanterns and cloth banners strung above a narrow street at night',
  '교통': 'a station platform with a passing carriage blurred by motion',
  '돈·팁': 'coins and a folded paper slip on a worn café counter',
});
const DEFAULT_SCENE = 'a quiet everyday street corner in the last light of day';

/**
 * 문제 축 → 영어 장면 어휘. `config/cardnews.json channel.problem_axes` 8종과 1:1.
 * 전부 **사람이 없는 장소**다 — 감정을 인물로 그리면 값싸지고 초상 문제가 따라온다.
 */
const PROBLEM_SCENES = Object.freeze({
  '연애·이별':        'an unmade bed by a window at dawn, one curtain half drawn',
  '인간관계·거리':    'two empty chairs at a cafe table, one cup left cooling',
  '가족':             'a worn dining table in an empty kitchen, late afternoon light',
  '자기 자신과의 관계': 'a single lamp lit in a dim room, an open notebook face down',
  '일과 소진':        'an empty office corridor after hours, one desk light still on',
  '불안·비교':        'rain running down a bus window at night, city lights out of focus',
  '상실·애도':        'an empty bench in a park under bare winter branches',
  '변화·선택':        'a quiet road forking into morning fog, no cars',
});

/** 카드별 생성(`per_card`) 시 같은 장면을 반복하지 않도록 프레이밍만 바꾼다. */
const FRAMINGS = Object.freeze([
  'wide establishing shot', 'close-up detail', 'low angle looking up',
  'overhead flat view', 'shot through a doorway', 'reflection in glass', 'long lens compression',
]);

/**
 * 대본 → 영어 배경 프롬프트.
 *
 * 모든 프롬프트가 강제하는 것: 에디토리얼 사진 톤 · **글자/간판/알아볼 수 있는 얼굴 없음** ·
 * 흰 글씨가 얹힐 수 있는 절제된 팔레트 · 얕은 심도.
 * (`shorts/imagen.mjs refinePrompt` 가 뒤에 "cinematic / dark moody / no text" 를 한 번 더 붙인다.)
 *
 * @param {object} script 카드 대본(cover.country / domain 사용)
 * @param {object} cfg    cardnews 설정
 * @param {{variant?:number}} [opt] per_card 생성 시 슬라이드 인덱스
 */
export function buildBgPrompt(script, cfg, opt = {}) {
  // 🔴 버티컬 전환(2026-07-31) — 이 함수는 "엔진"이 아니라 **콘텐츠 레이어**다.
  // 옛 버전은 `cover.country` 를 영문 국명으로 바꿔 `everyday life in <country>` 를 만들었는데,
  // 이 채널에서 `cover.country` 는 **책 제목** 자리라 그대로 두면 "everyday life in 오만과 편견"
  // 이 된다(다른 실행자가 잡아낸 오분류).
  //
  // 설계 선택: **문제를 그림으로 설명하지 않는다.** 이별을 우는 사람으로 그리면 값싸지고,
  // 인물이 들어가면 초상 문제도 생긴다. 대신 그 감정이 머무는 **빈 장소**를 찍는다 —
  // 읽는 사람이 자기 장면을 얹을 여백이 생기고, 흰 글씨가 앉을 자리도 같이 확보된다.
  const axis = String(script?.item?.axis ?? script?.axis ?? '').trim();
  const scene = PROBLEM_SCENES[axis] || DEFAULT_SCENE;
  const framing = Number.isInteger(opt.variant) ? `${FRAMINGS[opt.variant % FRAMINGS.length]}, ` : '';
  return [
    `Quiet atmospheric editorial photograph, no people: ${framing}${scene}.`,
    'Muted desaturated palette, deep shadows, shallow depth of field with soft background blur, natural available light.',
    'Generous empty negative space through the middle of the frame so that white type can be laid over it.',
    'No text, no lettering, no signage, no logos, no readable writing of any kind.',
    'No faces, no portraits, no people, no recognizable individuals.',
  ].join(' ');
}

/** 파일이 실재하고 비어있지 않은가. 0바이트 캐시를 성공으로 오인하면 배경 없는 카드가 나온다. */
const usable = (p) => { try { return existsSync(p) && statSync(p).size > 0; } catch { return false; } };

/**
 * 배경 1장 생성 → `<dir>/bg.png` 캐시. 이미 있으면 재사용(같은 post 를 다시 렌더해도 재과금 없음).
 *
 * @param {object} script
 * @param {string} dir     렌더 작업 디렉터리
 * @param {object} cfg
 * @param {{generate?:Function, variant?:number, name?:string}} [deps] 테스트 주입점(기본은 실 Vertex 호출)
 * @returns {Promise<{ok:boolean, path?:string, cached?:boolean, reason?:string}>} **throw 하지 않는다**
 */
export async function ensureBackground(script, dir, cfg, deps = {}) {
  try {
    if (!imagenEnabled(cfg)) return { ok: false, reason: 'disabled' };
    if (!dir) return { ok: false, reason: 'dir 없음' };
    const path = join(dir, deps.name || 'bg.png');
    if (usable(path)) return { ok: true, path, cached: true };

    const generate = deps.generate || (await import('../shorts/imagen.mjs')).generateImage;
    const prompt = buildBgPrompt(script, cfg, { variant: deps.variant });
    const r = await generate(prompt, path, cfg);
    if (!r || !r.ok) return { ok: false, reason: String(r?.error ?? '생성 실패') };
    if (!usable(path)) return { ok: false, reason: '생성은 ok 인데 파일이 비었음' };
    return { ok: true, path, cached: false };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/**
 * 슬라이드 수만큼의 배경 경로 배열. 기본(`per_card=false`)은 **1장을 전 슬라이드가 공유**한다.
 * 실패한 자리는 null → 호출자가 그 슬라이드만 그라데이션으로 그린다.
 *
 * @returns {Promise<{ok:boolean, paths:(string|null)[], reason?:string, generated:number}>}
 */
export async function ensureBackgrounds(script, dir, cfg, deps = {}) {
  const total = cfg?.cards?.count ?? 7;
  const none = new Array(total).fill(null);
  if (!imagenEnabled(cfg)) return { ok: false, reason: 'disabled', paths: none, generated: 0 };

  if (!cfg.imagen?.per_card) {
    const r = await ensureBackground(script, dir, cfg, deps);
    return r.ok
      ? { ok: true, paths: new Array(total).fill(r.path), generated: r.cached ? 0 : 1, cached: r.cached }
      : { ok: false, reason: r.reason, paths: none, generated: 0 };
  }

  const results = await Promise.all(
    Array.from({ length: total }, (_, i) =>
      ensureBackground(script, dir, cfg, { ...deps, variant: i, name: `bg-${String(i + 1).padStart(2, '0')}.png` })));
  const paths = results.map(r => (r.ok ? r.path : null));
  const okN = paths.filter(Boolean).length;
  return {
    ok: okN > 0, paths, generated: results.filter(r => r.ok && !r.cached).length,
    reason: okN ? undefined : (results.find(r => !r.ok)?.reason ?? '전부 실패'),
  };
}
