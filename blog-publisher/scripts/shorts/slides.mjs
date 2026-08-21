#!/usr/bin/env node
/**
 * shorts/slides.mjs — 카드 시각요소 렌더 (배경 + 오버레이 분리)
 *
 * 단조로움 해결 설계: 배경은 카드별 AI 이미지(Imagen), 텍스트는 투명 오버레이로
 * 분리 렌더한다. ffmpeg 에서 [배경 켄번스 줌] 위에 [투명 오버레이]를 얹으면
 * 이미지엔 모션, 글자는 또렷하게 유지된다. AI 이미지가 없으면 그라데이션 배경 폴백.
 *
 * 기존 Playwright chromium(vendor/chromium-libs LD 우회, sudo 불필요) 재사용.
 * 산출: work/<slug>/bg-NN.png (배경) + ov-NN.png (투명 오버레이).
 */
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, workDir } from './lib.mjs';
import { splitGroups, kineticEnabled } from './captions.mjs';

/** sudo 없는 WSL 우회 — lib/browser-render.mjs 와 동일 레시피. */
function vendorLdPath() {
  const base = join(REPO_ROOT, 'vendor', 'chromium-libs', 'root');
  if (!existsSync(base)) return null;
  const parts = [
    join(base, 'usr', 'lib', 'x86_64-linux-gnu'),
    join(base, 'lib', 'x86_64-linux-gnu'),
  ].filter(existsSync);
  return parts.length ? parts.join(':') : null;
}

/** 한국어 폰트 @font-face 임베드(base64). 최초 1회 캐시. */
let _fontCss = null;
function fontFaceCss() {
  if (_fontCss !== null) return _fontCss;
  const dir = join(REPO_ROOT, 'assets', 'shorts', 'fonts');
  const faces = [
    { file: 'Pretendard-Bold.woff2', weight: 700 },
    { file: 'Pretendard-ExtraBold.woff2', weight: 800 },
  ];
  const parts = [];
  for (const f of faces) {
    const p = join(dir, f.file);
    if (!existsSync(p)) continue;
    const b64 = readFileSync(p).toString('base64');
    parts.push(`@font-face{font-family:'Pretendard';font-weight:${f.weight};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
  }
  _fontCss = parts.join('');
  return _fontCss;
}

/** 카드별 액센트 색(순환) — 카드가 서로 달라 보이게. */
const ACCENTS = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb7185'];

/** 숫자·퍼센트 강조: caption 안의 수치를 액센트 색 span 으로 감싼다. */
function emphasize(caption, accent) {
  const safe = String(caption || '').replace(/[&<>]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]));
  return safe.replace(/([0-9]+(?:[.,][0-9]+)?%?)/g, `<span style="color:${accent}">$1</span>`);
}

/**
 * 투명 오버레이 HTML — 배경 없음(투명), 하단·중앙 스크림 그라데이션으로 가독성 확보 +
 * 큰 자막 + 뱃지 + 브랜드 + 진행바. AI 이미지 위에 얹힌다.
 */
/** 자막 세로 위치(화면 높이 %). 하단 bottom 앵커(구 190~210px)는 폰 세로 UI(제목·설명·버튼)에
 *  가려져 2026-07-17 사용자 지적으로 화면 세로 중앙으로 이동. config captions.vertical_pct 로 조절.
 *  ⚠ 극단값(15/85 근처) + 매우 긴 자막이면 body{overflow:hidden} 때문에 텍스트가 잘릴 수 있음
 *  — 기본 50(중앙)·짧은 caption 에선 안전. 극단값 사용 시 자막 길이 확인 필요. */
const CAPTION_VERTICAL_PCT = 50;
function clampVpct(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(85, Math.max(15, n)) : CAPTION_VERTICAL_PCT;
}

export function overlayHtml({ caption, kind, accent, vpct = CAPTION_VERTICAL_PCT }) {
  // 자막만(배경 박스 없음 — 사용자 요청 2026-07-18). 화면 세로 중앙, 강한 그림자 헤일로로 가독성.
  const size = kind === 'hook' ? 100 : 84;
  const top = clampVpct(vpct);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  ${fontFaceCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1080px; height:1920px; background:transparent; }
  body { font-family:'Pretendard',sans-serif; color:#fff; position:relative; overflow:hidden; }
  /* 자막: 화면 세로 중앙(폰 하단 UI 회피). 배경 박스 없이 그림자 헤일로만으로 가독성.
     넓은 폭 + keep-all + balance 로 어절 단위 자연스러운 줄나눔. */
  .caption { position:absolute; left:48px; right:48px; top:${top}%; transform:translateY(-50%);
    text-align:center; font-size:${size}px; font-weight:800; line-height:1.34; letter-spacing:-1.5px;
    word-break:keep-all; overflow-wrap:break-word; text-wrap:balance;
    text-shadow:0 0 16px rgba(0,0,0,.92), 0 4px 14px rgba(0,0,0,.85), 0 2px 4px rgba(0,0,0,.95); }
  </style></head><body>
  <div class="caption">${emphasize(caption, accent)}</div>
  </body></html>`;
}

/**
 * 키네틱 자막 오버레이 — caption 을 어절 그룹으로 쪼개 activeIdx 그룹만 팝(액센트+확대),
 * 나머지는 흐리게. 레이아웃은 항상 전체 그룹을 그려 안정(글자가 튀지 않음).
 * 그룹별로 PNG 1장을 렌더해 조립 단계서 시간창으로 순차 노출 → 카라오케식 단어단위 자막.
 */
export function kineticOverlayHtml({ groups, activeIdx, kind, accent, vpct = CAPTION_VERTICAL_PCT }) {
  const size = kind === 'hook' ? 96 : 82;
  const top = clampVpct(vpct);
  const chips = groups.map((g, i) => {
    const on = i === activeIdx;
    const body = emphasize(g, on ? '#fff' : accent);
    // 활성=액센트색·전체불투명, 비활성=흰색 약간 흐리게. 색만으로 카라오케 강조(배경 박스 없음).
    const style = on ? `color:${accent};opacity:1;` : `color:#fff;opacity:.62;`;
    return `<span class="wg" style="${style}">${body}</span>`;
  }).join(' ');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  ${fontFaceCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1080px; height:1920px; background:transparent; }
  body { font-family:'Pretendard',sans-serif; position:relative; overflow:hidden; }
  /* 자막: 화면 세로 중앙(폰 하단 UI 회피). 배경 박스 없음(사용자 요청 2026-07-18) — 그림자 헤일로만.
     그룹(.wg)은 nowrap 라 어절 그룹 중간에서 줄이 끊기지 않음 → 자연스러운 줄나눔(그룹 사이에서만 개행). */
  .caption { position:absolute; left:48px; right:48px; top:${top}%; transform:translateY(-50%);
    font-size:${size}px; font-weight:800; line-height:1.34; letter-spacing:-1.5px;
    word-break:keep-all; display:flex; flex-wrap:wrap; gap:0 .34em; align-items:baseline; justify-content:center; }
  .wg { display:inline-block; white-space:nowrap;
    text-shadow:0 0 16px rgba(0,0,0,.92), 0 4px 14px rgba(0,0,0,.85), 0 2px 4px rgba(0,0,0,.95); }
  </style></head><body>
  <div class="caption">${chips}</div>
  </body></html>`;
}

/** 그라데이션 배경 HTML — AI 이미지 없을 때 폴백(카드별 다른 톤). */
export function gradientBgHtml({ kind, accent }) {
  const palettes = { hook: ['#0b1220', '#1e3a8a'], card: ['#0b1220', '#0e7490'], cta: ['#1e1b4b', '#6d28d9'] };
  const [c1, c2] = palettes[kind] || palettes.card;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0} html,body{width:1080px;height:1920px}
  body{background:radial-gradient(120% 80% at 50% 25%, ${c2} 0%, ${c1} 70%);position:relative;overflow:hidden}
  .glow{position:absolute;width:900px;height:900px;border-radius:50%;
    background:radial-gradient(circle, ${accent}44 0%, transparent 62%);top:280px;left:90px;filter:blur(20px)}
  </style></head><body><div class="glow"></div></body></html>`;
}

/** slideList — hook + cards + cta 순, 각 슬라이드 메타(caption/kind/index/accent/image_prompt). */
export function slideList(script) {
  const total = script.cards.length;
  const out = [];
  out.push({ caption: script.hook, kind: 'hook', index: 0, total, accent: ACCENTS[0], image_prompt: script.hook_image_prompt || '' });
  script.cards.forEach((c, i) => out.push({
    caption: c.caption, kind: 'card', index: i + 1, total,
    accent: ACCENTS[(i + 1) % ACCENTS.length], image_prompt: c.image_prompt || '',
  }));
  if (script.cta) out.push({ caption: script.cta, kind: 'cta', index: total, total, accent: ACCENTS[(total + 1) % ACCENTS.length], image_prompt: '' });
  return out;
}

/**
 * 시각요소 렌더. aiImages[i] = AI 배경 png 경로(있으면 배경으로 사용) 또는 null(그라데이션 폴백).
 * @returns {Promise<{ overlays:string[], backgrounds:string[], slides:object[] }>}
 */
export async function renderVisuals(script, { dir, aiImages = [], cfg } = {}) {
  dir = dir || workDir(script.slug);
  mkdirSync(dir, { recursive: true });
  const slides = slideList(script);
  const kinetic = kineticEnabled(cfg);
  const vendor = vendorLdPath();
  const env = vendor
    ? { ...process.env, LD_LIBRARY_PATH: [vendor, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
    : process.env;
  const browser = await chromium.launch({
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'], env,
  });
  const vpct = cfg?.captions?.vertical_pct;   // 자막 세로 위치(%) — 없으면 overlay 기본(중앙 50%)
  const overlays = [], backgrounds = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
    for (let i = 0; i < slides.length; i++) {
      // 배경: AI 이미지가 있으면 그대로, 없으면 그라데이션 렌더
      const bgOut = join(dir, `bg-${String(i).padStart(2, '0')}.png`);
      if (aiImages[i] && existsSync(aiImages[i])) {
        copyFileSync(aiImages[i], bgOut);
      } else {
        await page.setContent(gradientBgHtml(slides[i]), { waitUntil: 'networkidle' });
        await page.screenshot({ path: bgOut, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
      }
      backgrounds.push(bgOut);
      // 오버레이: 키네틱(그룹별 PNG 배열) 또는 정적(단일 PNG)
      const groups = splitGroups(slides[i].caption, cfg?.captions?.group_words ?? 2);
      if (kinetic && groups.length > 1) {
        const frames = [];
        for (let gi = 0; gi < groups.length; gi++) {
          const ovOut = join(dir, `ov-${String(i).padStart(2, '0')}-${String(gi).padStart(2, '0')}.png`);
          await page.setContent(kineticOverlayHtml({ groups, activeIdx: gi, kind: slides[i].kind, accent: slides[i].accent, vpct }), { waitUntil: 'networkidle' });
          await page.evaluate(() => document.fonts.ready).catch(() => {});
          await page.screenshot({ path: ovOut, omitBackground: true, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
          frames.push(ovOut);
        }
        overlays.push(frames);
      } else {
        const ovOut = join(dir, `ov-${String(i).padStart(2, '0')}.png`);
        await page.setContent(overlayHtml({ ...slides[i], vpct }), { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready).catch(() => {});
        await page.screenshot({ path: ovOut, omitBackground: true, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
        overlays.push(ovOut);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { overlays, backgrounds, slides };
}
