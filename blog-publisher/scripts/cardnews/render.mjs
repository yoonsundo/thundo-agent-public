#!/usr/bin/env node
/**
 * cardnews/render.mjs — 1080×1350 JPEG 카드 7장 렌더 (계획 §3.9, AC-4/5/6)
 *
 * cover(1) + cards(5) + outro(1) = 7. Playwright headless chromium 으로 HTML 을
 * 그려 `page.screenshot({type:'jpeg'})` 로 바로 JPEG 을 뽑는다 — 변환 라이브러리·
 * 신규 의존성 0개(AC-6).
 *
 * ⚠ **두부(□) 방지가 이 모듈의 핵심**이다. headless chromium 에는 시스템 한글 폰트가
 * 없어, @font-face 임베드가 실패하면 한 글자도 못 읽는 카드가 조용히 산출된다(이 레포가
 * 실제로 겪은 결함). `assertFontLoaded` 가 카드마다 이를 **렌더 단계에서 실패**시킨다.
 *
 * ⚠ **이모지도 렌더되지 않는다**(실측 2026-07-31: `🇯🇵` 폭 96px = 두부 2칸,
 * `📌` 48px = 두부 1칸). 따라서 카드 이미지에는 이모지를 넣지 않는다 — 국가 표시는
 * `country` 텍스트 pill 로 그린다. `flag_emoji` 는 캡션(인스타 앱이 직접 렌더)용으로만
 * 남는다. 계획 §3.9 루브릭 5의 "국기 배지"를 국가명 배지로 읽었다.
 *
 * ── AI 배경 합성(2026-07-31) ────────────────────────────────────────────────
 * 배경 = [AI 사진] → [스크림] → [기존 텍스트 레이어]. 사진은 1024² 정사각으로 오는데
 * CSS `background-size:cover` 가 1080×1350 커버크롭을 대신 해 준다(ffmpeg·이미지 라이브러리
 * ·신규 의존성 0개). **스크림이 이 기능의 성패를 가른다** — 흰 글씨는 통제된 어두운 층
 * 없이는 사진 위에서 읽히지 않는다. 아래 `bgLayers` 의 알파는 "사진이 순백일 때조차"
 * 본문 대비 4.5:1 이 나오도록 역산한 값이다(근거는 그 함수 주석).
 * imagen 이 꺼졌거나 생성이 실패하면 **기존 그라데이션 카드가 그대로** 나온다(무중단).
 */
import { chromium } from 'playwright';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { fontFaceCss, launchArgs, launchEnv } from '../lib/browser-render.mjs';
import { loadConfig, workDir, sha256File, isMainModule } from './lib.mjs';
import { readJpegDims } from './gates.mjs';
import { ensureBackgrounds, imagenEnabled } from './imagen.mjs';

const log = makeLogger('cardnews/render');

const W = 1080;
const H = 1350;

/** 안전 여백(루브릭 2: 모든 텍스트가 가장자리에서 ≥64px 안쪽). */
const PAD = 88;

const C = {
  bg0: '#0a1020',
  bg1: '#16233f',
  ink: '#ffffff',
  body: '#dce5f2',
  muted: '#93a4c0',
  accent: '#4cc3f5',
  accentInk: '#04121f',
  cta: '#fbbf24',
  /**
   * 표지 서브카피·진행 배지 전용 — **배경 사진이 있을 때만** muted(#93a4c0) 대신 쓴다.
   * muted 의 상대휘도는 0.365 로 너무 낮아, 사진 위에서는 스크림을 아무리 얹어도 4.5:1 을
   * 아슬아슬하게만 넘긴다(실측 4.57:1 — 회귀 게이트로 쓰기엔 여유가 없다). 여기서 색을
   * 밝히지 않고 스크림만 두껍게 하면 정작 사진이 사라지므로, **사진 위에서만** 한 단계
   * 밝힌다(0.687). 그라데이션 카드는 기존 muted 그대로라 디자인이 바뀌지 않는다.
   */
  subOnBg: '#cfd9e8',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

/**
 * 스크림 기본값. `config/cardnews.json imagen.scrim` 으로 덮어쓸 수 있다.
 *
 * 🔴 **고정 알파는 쓰지 않는다.** 최악(순백) 사진 기준으로 알파를 고정하면 0.72 가 필요한데,
 * 실제로 오는 사진은 이미 어둡다 — `shorts/imagen.mjs refinePrompt` 가 모든 프롬프트에
 * "dark moody tones" 를 강제로 덧붙이기 때문이고, 그 파일은 zero-diff 대상이라 못 고친다.
 * 어두운 사진 위에 0.72 를 더 얹으면 사진이 사실상 사라진다(실측: 그냥 검은 카드).
 * 그래서 **사진마다 실제 픽셀을 재서 필요한 만큼만** 덮는다(`solveScrimAlpha`).
 *
 * `shape` 는 flat 위에 **더해지기만** 하는 장식용 세로 그라데이션이다(합성 유효알파는
 * 1−(1−flat)(1−shape) ≥ flat). 즉 대비 보장은 flat 하나가 전담하고, shape 는 그보다
 * 어둡게만 만들 수 있다 — 이 성질 덕분에 역산이 shape 와 무관하게 성립한다.
 */
const SCRIM = Object.freeze({
  tint: '#040812',
  target_ratio: 5.0,        // 4.5 목표에 JPEG 아티팩트·측정오차 여유를 얹은 실제 역산 목표
  min_alpha: 0.18,          // 아주 어두운 사진에서도 최소한의 통일감(7장이 한 세트로 읽히게)
  max_alpha: 0.92,
  shape: [0.14, 0.00, 0.14, 0.34],
  shape_stops: [0, 20, 52, 100],
  body_extra_alpha: 0.12,
  body_blur_px: 7,
  cover_blur_px: 0,
  saturate: 0.85,
});

/**
 * 알파 역산이 들여다보는 세로 범위 = **글자가 놓일 수 있는 모든 구간**.
 * 스테이지(본문)뿐 아니라 우하단 진행 배지(`.step`)까지 포함해야 한다 — 스테이지만 재면
 * 배지 자리가 밝은 사진에서 배지만 대비 미달로 남는다(실측 4.57:1 로 여유가 거의 없었다).
 * 좌상단 `.pill` 은 불투명 배경이라 대비와 무관하지만, 같은 구간에 들어와도 보수적일 뿐 해롭지 않다.
 */
const TEXT_BAND = Object.freeze([PAD, H - PAD]);

const hexRgb = (hex) => {
  const h = String(hex ?? '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [4, 8, 18];
};

/**
 * 역산 기준색 = 스테이지 안에서 **가장 어두운 글자색**. 아웃트로 CTA(#fbbf24, 상대휘도 0.579)가
 * 그것이다. 슬라이드마다 다른 색으로 따로 풀 수도 있지만, 한 값으로 통일해야 7장의 스크림 농도가
 * 같아져 덱이 한 세트로 읽힌다(같은 사진을 공유하는 설계와 같은 이유).
 */
const scrimRefLum = () => srgbLuminance(...hexRgb(C.cta));

/**
 * 사진 위 스크림 알파 역산 — "이 픽셀 위에 흰 글씨를 얹어 target:1 이 나오려면 얼마나 덮어야 하나".
 *
 * 브라우저는 sRGB 감마 공간에서 알파합성하므로 채널값은 a·tint+(1−a)·photo 로 선형이지만,
 * 상대휘도는 채널마다 비선형이라 닫힌 해가 없다. 단조(알파↑ ⇒ 휘도↓)이므로 이분탐색으로 푼다.
 *
 * @param {number[]} photoRgb 글자 자리에서 **가장 밝은 블록**의 평균 RGB
 * @returns {number} [min_alpha, max_alpha] 로 클램프된 알파
 */
export function solveScrimAlpha(photoRgb, cfg) {
  const s = { ...SCRIM, ...(cfg?.imagen?.scrim || {}) };
  const tint = hexRgb(s.tint);
  const allowed = (scrimRefLum() + 0.05) / s.target_ratio - 0.05;
  let lo = 0, hi = 1;
  for (let k = 0; k < 30; k++) {
    const a = (lo + hi) / 2;
    const L = srgbLuminance(...photoRgb.map((p, i) => a * tint[i] + (1 - a) * p));
    if (L > allowed) lo = a; else hi = a;
  }
  return Math.min(s.max_alpha, Math.max(s.min_alpha, hi));
}

/**
 * 배경 사진 + 스크림 두 겹. `strong` 은 본문·아웃트로 카드 — 표지보다 스크림을 조금 더 얹고
 * 약하게 블러해 글자가 지배하게 하고, 7장이 한 세트로 읽히게 만든다(같은 사진을 공유하므로).
 * 블러를 걸 때만 `scale` 을 주어 블러가 가장자리에서 투명해지는 것을 막는다.
 *
 * @param {{uri:string, alpha:number}} bd `computeBackdrops` 산출물
 */
function bgLayers(bd, strong, cfg) {
  const s = { ...SCRIM, ...(cfg?.imagen?.scrim || {}) };
  const [r, g, b] = hexRgb(s.tint);
  const rgba = (a) => `rgba(${r},${g},${b},${a})`;
  const flat = strong ? 1 - (1 - bd.alpha) * (1 - s.body_extra_alpha) : bd.alpha;
  const stops = s.shape.map((a, i) => `${rgba(a)} ${s.shape_stops[i]}%`).join(',');
  const blur = strong ? s.body_blur_px : s.cover_blur_px;
  const filt = [blur > 0 ? `blur(${blur}px)` : '', s.saturate !== 1 ? `saturate(${s.saturate})` : ''].filter(Boolean).join(' ');
  // 🔴 data URI 는 **홑따옴표**로 감싼다. `url("…")` 를 쓰면 그 큰따옴표가 `style="…"` 속성을
  // 그 자리에서 끝내 버려 배경이 통째로 사라진다(스크림만 남아 "그냥 어두운 카드"가 되는데,
  // 대비 테스트는 오히려 더 잘 통과해서 조용히 초록불이 된다 — 실제로 한 번 당했다).
  // base64 알파벳에 홑따옴표는 없으므로 이스케이프 문제도 없다.
  const style = `background-image:url('${bd.uri}')` + (filt ? `;filter:${filt}` : '') + (blur > 0 ? ';transform:scale(1.08)' : '');
  return `<div class="bg" style="${style}"></div>`
    + `<div class="scrim" style="background:linear-gradient(180deg,${stops}),${rgba(flat.toFixed(4))}"></div>`;
}

/**
 * 카드 공통 껍데기. 국가 pill(좌상단)·진행 배지(우하단)를 **7장 모두 동일 좌표**에
 * 그려 루브릭 5(±2px 정렬)를 구조적으로 보장한다 — 카드 종류별로 따로 배치하지 않는다.
 *
 * `bg`(data URI) 가 없으면 마크업이 예전과 **완전히 동일**하다 — 폴백 경로에 새 노드가
 * 끼어들지 않는다.
 */
function shell({ country, index, total, tint, inner, bg, strong, cfg }) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  ${fontFaceCss()}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px}
  body{font-family:'Pretendard',sans-serif;color:${C.ink};
    background:radial-gradient(125% 90% at 18% 8%, ${tint} 0%, ${C.bg1} 45%, ${C.bg0} 100%);
    position:relative;word-break:keep-all;overflow-wrap:break-word;overflow:hidden}
  .bg{position:absolute;inset:0;background-size:cover;background-position:center;background-repeat:no-repeat}
  .scrim{position:absolute;inset:0}
  .pill{position:absolute;left:${PAD}px;top:${PAD}px;
    background:${C.accent};color:${C.accentInk};font-weight:800;font-size:30px;
    letter-spacing:-.5px;padding:12px 26px;border-radius:999px;white-space:nowrap}
  .step{position:absolute;right:${PAD}px;bottom:${PAD}px;
    color:${bg ? C.subOnBg : C.muted};font-weight:700;font-size:30px;letter-spacing:1px;
    font-variant-numeric:tabular-nums}
  .stage{position:absolute;left:${PAD}px;right:${PAD}px;top:${PAD + 96}px;bottom:${PAD + 78}px;
    display:flex;flex-direction:column;justify-content:center}
  .rule{width:104px;height:8px;border-radius:4px;background:${C.accent};margin-bottom:34px}
  .h{font-weight:800;letter-spacing:-2px;line-height:1.24}
  .b{color:${C.body};font-weight:700;letter-spacing:-.6px}
  </style></head><body>
  ${bg ? bgLayers(bg, strong, cfg) : ''}
  <div class="pill">${esc(country)}</div>
  <div class="stage">${inner}</div>
  <div class="step">${index} / ${total}</div>
  </body></html>`;
}

/** 표지 — 국가 + 훅 headline(≤24자) + sub(≤34자). */
export function coverHtml(cover, cfg) {
  const total = cfg?.cards?.count ?? 7;
  return shell({
    country: cover.country, index: 1, total, tint: '#1d4ed8',
    bg: cfg?.__bg ?? null, strong: false, cfg,
    inner: `
    <div class="rule"></div>
    <div class="h" style="font-size:94px">${esc(cover.headline)}</div>
    <div class="b" style="font-size:42px;line-height:1.5;margin-top:36px;color:${cfg?.__bg ? C.subOnBg : C.muted}">${esc(cover.sub ?? '')}</div>`,
  });
}

/** 본문 — headline(≤24자) + body(≤90자). i 는 1-based 카드 순번(슬라이드 번호는 i+1). */
export function cardHtml(card, i, total, cfg) {
  const country = cfg?.__country ?? '';
  return shell({
    country, index: i + 1, total, tint: '#0e5c72',
    bg: cfg?.__bg ?? null, strong: true, cfg,
    inner: `
    <div class="rule"></div>
    <div class="h" style="font-size:70px">${esc(card.headline)}</div>
    <div class="b" style="font-size:40px;line-height:1.62;margin-top:34px">${esc(card.body)}</div>`,
  });
}

/** 마무리 — 저장 유도. */
export function outroHtml(outro, cfg) {
  const total = cfg?.cards?.count ?? 7;
  const country = cfg?.__country ?? '';
  return shell({
    country, index: total, total, tint: '#4c1d95',
    bg: cfg?.__bg ?? null, strong: true, cfg,
    inner: `
    <div class="rule" style="background:${C.cta}"></div>
    <div class="h" style="font-size:70px">${esc(outro.headline)}</div>
    <div class="b" style="font-size:40px;line-height:1.62;margin-top:34px">${esc(outro.body)}</div>
    <div style="margin-top:52px;font-size:38px;font-weight:800;color:${C.cta};letter-spacing:-.6px">저장해 두고 여행 전에 다시 보기</div>`,
  });
}

/**
 * 폰트 미적용을 **렌더 단계에서** 잡는다(AC-5).
 *
 * 고정 한글 문자열을 두 번 재서, Pretendard 가 실제로 글자를 그렸을 때만 통과시킨다.
 * 두 span 모두 `white-space:nowrap` 이라 줄바꿈이 폭을 같게 만들어 실패를 가리는 일이 없다.
 *
 * ⚠ 계획 §3.9 스니펫에서 **두 곳을 고쳤다**(실측 근거):
 *  ① 대조군이 `'__nonexistent__', sans-serif` 인데 실험군은 `'Pretendard'` **단독**이라,
 *    폰트가 없을 때 실험군은 브라우저 기본 폰트로·대조군은 sans-serif 로 떨어져 **폭이
 *    달라진다** → 두부인데 통과. 실험군을 `'Pretendard', sans-serif` 로 맞춰 두 체인의
 *    말단을 같게 했다. 이제 Pretendard 부재 시 두 폭이 정확히 일치해 반드시 걸린다.
 *  ② `document.fonts.check()` 는 @font-face 가 **아예 선언되지 않은** 페이지에서 `true` 를
 *    돌려준다(폴백으로 그릴 수 있으니 "준비됨"). 즉 단독으로는 두부를 못 잡는다 —
 *    보조 신호로만 쓰고, 판정의 무게는 폭 비교에 둔다. (실측 2026-07-31)
 *
 * ⚠ `strings`·픽셀 히스토그램 검사는 두부(□)에서도 통과하므로 쓰지 않는다.
 */
export async function assertFontLoaded(page) {
  const r = await page.evaluate(() => {
    const measure = (family) => {
      const s = document.createElement('span');
      s.textContent = '한글확인테스트';
      s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:700 48px ${family}`;
      document.body.appendChild(s);
      const w = s.getBoundingClientRect().width;
      s.remove();
      return w;
    };
    return {
      loaded: document.fonts.check('700 48px Pretendard'),
      pretendard: measure("'Pretendard', sans-serif"),
      fallback: measure("'__nonexistent__', sans-serif"),
    };
  });
  if (!r.loaded || Math.abs(r.pretendard - r.fallback) <= 1) {
    throw new Error(`폰트 미적용 — 두부 렌더 위험 (loaded=${r.loaded}, ${r.pretendard} vs ${r.fallback})`);
  }
  return r;
}

/**
 * 대본 → 슬라이드 7장의 HTML 배열. cover(1) + cards(5) + outro(1) 이 스키마 수준의 7 보장.
 * @param {({uri:string,alpha:number}|null)[]|null} backdrops 슬라이드별 배경. null 자리는 그라데이션.
 */
export function slideHtmls(script, cfg, backdrops = null) {
  const total = cfg?.cards?.count ?? 7;
  const at = (i) => ({ ...cfg, __country: script.cover?.country ?? '', __bg: (backdrops && backdrops[i]) || null });
  const out = [coverHtml(script.cover, at(0))];
  script.cards.forEach((c, i) => out.push(cardHtml(c, i + 1, total, at(i + 1))));
  out.push(outroHtml(script.outro, at(total - 1)));
  return out;
}

/** sRGB 8bit → WCAG 상대휘도. 대비 실측(테스트 (g))과 스크림 역산이 같은 식을 쓴다. */
export function srgbLuminance(r, g, b) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 명암비. 인자 순서 무관. */
export function contrastRatio(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 이미지 매직바이트 → data URI. 확장자가 아니라 내용으로 판정한다(Gemini 응답은 .png 로 저장되지만 보장은 없다). */
function imageDataUri(path) {
  const buf = readFileSync(path);
  const mime = (buf[0] === 0x89 && buf[1] === 0x50) ? 'image/png'
    : (buf[0] === 0xFF && buf[1] === 0xD8) ? 'image/jpeg'
      : (buf.slice(0, 4).toString('latin1') === 'RIFF') ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 사진에서 **글자가 앉는 띠의 가장 밝은 16px 블록** 평균 RGB. 이 값 하나가 스크림 알파를 정한다.
 *
 * 왜 단일 픽셀 최댓값이 아니라 16px 블록 평균인가 — 글자 획은 40~94px 폰트에서 5~12px 굵기라,
 * 눈은 획 뒤의 **국소 평균**을 배경으로 인식한다. 픽셀 하나짜리 하이라이트에 맞춰 알파를 올리면
 * 사진 전체가 필요 이상으로 어두워진다(고정 알파로 돌아가는 셈).
 *
 * 캔버스에는 CSS `background-size:cover` 와 **같은 기하**로 그린다 — 그래야 잰 픽셀이 실제로
 * 화면에 나오는 픽셀과 일치한다(가정한 배경이 아니라 진짜 배경을 재는 것이 요점).
 */
async function brightestBlock(page, uri) {
  return page.evaluate(async ({ uri, w, h, band }) => {
    const im = new Image();
    im.src = uri;
    await im.decode();
    const s = Math.max(w / im.naturalWidth, h / im.naturalHeight);   // = background-size:cover
    const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);            // = background-position:center
    const rel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const B = 16;
    let best = [0, 0, 0], bestL = -1;
    for (let y = band[0]; y + B <= band[1]; y += B) {
      const row = cx.getImageData(0, y, w, B).data;
      for (let x = 0; x + B <= w; x += B) {
        let r = 0, g = 0, b = 0;
        for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
          const k = (j * w + x + i) * 4;
          r += row[k]; g += row[k + 1]; b += row[k + 2];
        }
        const n = B * B;
        r /= n; g /= n; b /= n;
        const L = 0.2126 * rel(r) + 0.7152 * rel(g) + 0.0722 * rel(b);
        if (L > bestL) { bestL = L; best = [r, g, b]; }
      }
    }
    return best;
  }, { uri, w: W, h: H, band: TEXT_BAND });
}

/**
 * data URI 배열 → `{uri, alpha}` 배열. 같은 사진은 한 번만 잰다(기본값 per_card=false 에서는 1회).
 * `page` 는 캔버스 호스트로만 쓰인다 — 아무 문서나 열려 있으면 된다.
 */
export async function computeBackdrops(page, uris, cfg) {
  const cache = new Map();
  const out = [];
  for (const uri of uris) {
    if (!uri) { out.push(null); continue; }
    if (!cache.has(uri)) {
      const probe = await brightestBlock(page, uri);
      cache.set(uri, { uri, alpha: solveScrimAlpha(probe, cfg), probe });
    }
    out.push(cache.get(uri));
  }
  return out;
}

/**
 * 배경 사진이 실제로 디코드된 뒤에 스크린샷을 찍게 만든다. data URI 는 네트워크 이벤트를
 * 내지 않아 `networkidle` 로는 보장되지 않는다 — 디코드 전에 찍으면 스크림만 찍힌다.
 * URI 는 computed style 에서 되읽어 1.7MB 문자열을 CDP 로 한 번 더 보내지 않는다.
 */
async function awaitBackground(page) {
  await page.evaluate(async () => {
    const el = document.querySelector('.bg');
    if (!el) return;
    const m = /url\("?([^"]+)"?\)/.exec(getComputedStyle(el).backgroundImage || '');
    if (!m) return;
    const im = new Image();
    im.src = m[1];
    try { await im.decode(); } catch { /* 디코드 실패 = 스크림만 남음(폴백) */ }
  });
}

const slideName = (i) => `slide-${String(i + 1).padStart(2, '0')}.jpg`;

/**
 * 카드 7장 렌더.
 * @param {object} opt
 * @param {Function} [opt.generate] 배경 생성 주입점(테스트용). 없으면 실 Vertex 호출.
 * @returns {Promise<{ok, files[], sha256[], dims[], bytes[], quality, overflow[], background, reason?}>}
 *
 * 🔴 oversize 재렌더는 sha256 계산 **이전**에 끝난다 — sha 는 최종 산출물에 대해 단 한 번만
 * 계산되어야 재사용 술어(AC-14)와 호스팅 경로가 어긋나지 않는다.
 */
export async function renderCards(script, { dir, cfg, generate } = {}) {
  cfg = cfg || loadConfig();
  const r = cfg.render || {};
  const maxBytes = cfg.gates?.max_bytes ?? 8388608;

  // 폰트 CSS 가 비면 카드 전체가 두부로 나온다 — 브라우저를 띄우기도 전에 실패시킨다(§3.8).
  if (!fontFaceCss()) {
    throw new Error('폰트 임베드 실패 — assets/shorts/fonts/Pretendard-*.woff2 없음 (두부 렌더 위험)');
  }

  dir = dir || workDir(script.post_id);
  mkdirSync(dir, { recursive: true });

  // AI 배경 — 실패는 전부 그라데이션 폴백이고 렌더를 멈추지 않는다. 어느 경로를 탔는지 로그로 남긴다.
  let background = { mode: 'gradient', reason: 'disabled' };
  let bgUris = null;
  if (imagenEnabled(cfg)) {
    const bg = await ensureBackgrounds(script, dir, cfg, generate ? { generate } : {});
    if (bg.ok) {
      const used = bg.paths.filter(Boolean).length;
      background = { mode: 'ai', slides: used, generated: bg.generated, per_card: !!cfg.imagen?.per_card };
      log.info(`AI 배경 — ${used}/${bg.paths.length} 슬라이드 (신규 ${bg.generated}장, per_card=${background.per_card})`);
      const cache = new Map();
      bgUris = bg.paths.map(p => {
        if (!p) return null;
        if (!cache.has(p)) cache.set(p, imageDataUri(p));
        return cache.get(p);
      });
    } else {
      background = { mode: 'gradient', reason: bg.reason };
      log.warn(`AI 배경 실패(${bg.reason}) → 그라데이션 폴백`);
    }
  } else {
    log.info('AI 배경 비활성(imagen.enabled=false) → 그라데이션');
  }

  const browser = await chromium.launch({ headless: true, args: launchArgs(), env: launchEnv() });
  let quality = r.quality ?? 92;
  let files = [], bytes = [], overflow = [];
  try {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: r.device_scale_factor ?? 1,   // 2 면 2160×2700 — AC-4 의 "정확히" 가 깨진다
    });

    // 스크림 알파는 사진을 실제로 재서 정한다 → HTML 은 그 **뒤에** 만든다.
    let backdrops = null;
    if (bgUris) {
      backdrops = await computeBackdrops(page, bgUris, cfg);
      const seen = [...new Set(backdrops.filter(Boolean).map(b => b.alpha))];
      background.scrim_alpha = seen;
      log.info(`스크림 알파 실측 역산 — ${seen.map(a => a.toFixed(3)).join(', ')} (목표 ${(cfg.imagen?.scrim?.target_ratio ?? SCRIM.target_ratio)}:1)`);
    }
    const htmls = slideHtmls(script, cfg, backdrops);

    /** 전량 렌더 1회전. 파일·바이트·오버플로 정보를 갈아끼운다. */
    const pass = async (q) => {
      files = []; bytes = []; overflow = [];
      for (let i = 0; i < htmls.length; i++) {
        const path = join(dir, slideName(i));
        await page.setContent(htmls[i], { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready).catch(() => {});
        await assertFontLoaded(page);
        await awaitBackground(page);
        // JPEG 는 알파 미지원이라 omitBackground 를 쓰지 않는다(카드뉴스는 불투명).
        await page.screenshot({ path, type: 'jpeg', quality: q, clip: { x: 0, y: 0, width: W, height: H } });
        // 루브릭 4(텍스트 잘림 0) 기계 힌트 — 판정은 사람 몫이라 실패시키지 않고 보고만 한다.
        const clipped = await page.evaluate(() => {
          const st = document.querySelector('.stage');
          return !st ? false : st.scrollHeight > st.clientHeight + 1;
        });
        overflow.push(clipped);
        files.push(path);
        bytes.push(statSync(path).size);
      }
    };

    await pass(quality);
    if (bytes.some(b => b > maxBytes)) {
      const lower = r.requality_on_oversize ?? 82;
      log.warn(`oversize — quality ${quality} → ${lower} 로 전량 재렌더 (최대 ${Math.max(...bytes)}B)`);
      quality = lower;
      await pass(quality);
      if (bytes.some(b => b > maxBytes)) {
        return { ok: false, reason: 'oversize', files, bytes, quality, overflow, background, sha256: [], dims: [] };
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const sha256 = files.map(f => sha256File(f));
  const dims = files.map(f => readJpegDims(readFileSync(f)));
  return { ok: true, files, sha256, dims, bytes, quality, overflow, background };
}

async function main() {
  const scriptPath = process.argv[2];
  if (!scriptPath) { log.error('사용법: cardnews/render.mjs <script.json> [outdir]'); process.exit(2); }
  try {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
    const res = await renderCards(script, { dir: process.argv[3] });
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    log.error(`렌더 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
