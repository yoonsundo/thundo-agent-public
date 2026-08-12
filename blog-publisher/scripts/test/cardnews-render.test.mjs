#!/usr/bin/env node
/**
 * cardnews-render.test.mjs — Step 2 렌더러·이미지 게이트 유닛테스트 (AC-4/5/6/19)
 *
 * 검증:
 *   (a) 픽스처 7장이 정확히 1080×1350 JPEG 으로 렌더된다
 *   (b) `assertFontLoaded` 가 폰트가 붙은 실제 카드 페이지에서 통과한다
 *   (c) `assertFontLoaded` 가 @font-face 없는 페이지에서 **throw** 한다
 *   (d) 🔴 **폰트 파일을 감추면 `renderCards` 가 실패한다** — 이 테스트의 존재 이유.
 *       headless chromium 에는 시스템 한글 폰트가 없어 임베드가 깨지면 전 카드가 두부(□)로
 *       나오고, 해피패스만 보는 테스트는 그걸 절대 못 잡는다(이 레포가 실제로 겪은 결함).
 *   (e) `readJpegDims` 가 SOF 를 읽고 JPEG 아닌 입력에 null 을 낸다
 *   (f) 게이트가 6장 디렉터리를 exit 1 로 막고 **파일을 지우지 않는다**(AC-19)
 *   (g) AI 배경 생성이 **실패**해도 그라데이션으로 7장이 나온다(무중단 폴백)
 *   (h) 🔴 **로컬 픽스처 배경을 합성해도** 게이트(1080×1350·JPEG·≤8MB)를 통과하고,
 *       **글자가 앉는 자리의 실제 합성 픽셀** 대비가 4.5:1 이상이다. 순백 픽스처(어떤 실사진
 *       보다 가혹)와 어두운 픽스처(실제로 오는 톤) 양쪽에서 잰다 — 전자는 스크림 상한을,
 *       후자는 "스크림이 얇아져도 대비가 지켜지는가"를 검증한다. 배경이 **실제로 보이는지**도
 *       함께 단언한다(배경이 사라지면 대비는 오히려 좋아져 조용히 초록불이 되기 때문).
 *
 * 네트워크·크리덴셜 불필요 — (a) 는 imagen 을 끄고, (g)(h) 는 생성기를 주입/캐시로 대체한다.
 * `generate` 스텁 호출 수를 세어 "네트워크로 안 샜다"를 단언한다. exit 0 = 전체 통과 / 1 = 실패.
 *
 * ⚠ (d) 는 **자식 프로세스**로 돌린다 — `fontFaceCss()` 가 모듈 수준 캐시라 같은 프로세스에서
 * 파일을 감춰도 (a) 가 이미 채운 캐시를 그대로 쓴다(테스트가 조용히 무력화된다).
 */
import { mkdtempSync, rmSync, existsSync, renameSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const FIXTURE = join(REPO, 'benchmark', 'cardnews', 'sample-script.json');
const FONT_DIR = join(REPO, 'assets', 'shorts', 'fonts');
const FONTS = ['Pretendard-Bold.woff2', 'Pretendard-ExtraBold.woff2'];
const TMP = mkdtempSync(join(tmpdir(), 'cardnews-render-'));

const { renderCards, assertFontLoaded, coverHtml, srgbLuminance, contrastRatio } = await import('../cardnews/render.mjs');
const { readJpegDims, judge, listSlides } = await import('../cardnews/gates.mjs');
const { loadConfig } = await import('../cardnews/lib.mjs');

let passN = 0, failN = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
}

const loaded = loadConfig();
const script = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// 이 테스트는 **절대 Vertex 를 부르지 않는다**. (a) 는 imagen 을 끈 설정으로,
// (g)(h) 는 스텁 생성기/디스크 캐시로 돈다.
const cfg = { ...loaded, imagen: { ...(loaded.imagen ?? {}), enabled: false } };
const cfgAi = { ...loaded, imagen: { ...(loaded.imagen ?? {}), enabled: true, per_card: false } };

// ─── (a) 해피패스 ─────────────────────────────────────────────────────────────
console.log('\n(a) 픽스처 7장 렌더 (imagen off → 그라데이션)');
const outDir = join(TMP, 'render');
let gradientGenCalls = 0;
const res = await renderCards(script, {
  dir: outDir, cfg,
  generate: async () => { gradientGenCalls++; return { ok: false, error: '호출되면 안 됨' }; },
});
ok('ok=true', res.ok === true, JSON.stringify(res.reason ?? ''));
ok('imagen off 면 생성기를 아예 부르지 않음', gradientGenCalls === 0, `${gradientGenCalls}회`);
ok('background.mode=gradient', res.background?.mode === 'gradient', JSON.stringify(res.background));
ok('파일 7장', res.files.length === 7, `${res.files.length}장`);
ok('sha256 7개', res.sha256.length === 7 && res.sha256.every(s => /^[0-9a-f]{64}$/.test(s)));
ok('전부 1080×1350', res.dims.every(d => d && d.width === 1080 && d.height === 1350), JSON.stringify(res.dims));
ok('전부 8MB 이하', res.bytes.every(b => b <= cfg.gates.max_bytes), `최대 ${Math.max(...res.bytes)}B`);
ok('최장 픽스처에서 오버플로 0', res.overflow.every(o => o === false), JSON.stringify(res.overflow));
ok('게이트 통과', judge(listSlides(outDir), cfg).ok === true);

// ─── (b)(c) assertFontLoaded 단독 ─────────────────────────────────────────────
console.log('\n(b)(c) assertFontLoaded');
{
  const { launchArgs, launchEnv } = await import('../lib/browser-render.mjs');
  const browser = await chromium.launch({ headless: true, args: launchArgs(), env: launchEnv() });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });

    await page.setContent(coverHtml(script.cover, cfg), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    let posErr = null;
    const measured = await assertFontLoaded(page).catch(e => { posErr = e; return null; });
    ok('폰트 적용된 카드에서 통과', posErr === null, posErr?.message);
    ok('Pretendard 폭이 폴백과 1px 초과 차이', !!measured && Math.abs(measured.pretendard - measured.fallback) > 1,
      measured ? `${measured.pretendard} vs ${measured.fallback}` : 'n/a');

    // @font-face 가 없는 페이지 — 두 span 이 같은 폴백으로 그려져 폭이 일치한다.
    await page.setContent('<!doctype html><meta charset="utf-8"><body style="font-family:\'Pretendard\',sans-serif">한글</body>',
      { waitUntil: 'networkidle' });
    let negErr = null;
    await assertFontLoaded(page).catch(e => { negErr = e; });
    ok('폰트 없는 페이지에서 throw', negErr !== null && /두부/.test(negErr.message), negErr?.message ?? 'throw 안 함');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── (d) 폰트 은닉 → renderCards 실패 (자식 프로세스) ─────────────────────────
console.log('\n(d) 폰트 파일 은닉 시 렌더 실패');
{
  const hidden = FONTS.map(f => ({ from: join(FONT_DIR, f), to: join(FONT_DIR, `${f}.hidden-by-test`) }))
    .filter(h => existsSync(h.from));
  // 프로세스가 어떤 식으로 죽어도 폰트를 되돌린다 — 은닉 상태로 남으면 파이프라인 전체가 두부가 된다.
  const restore = () => { for (const h of hidden) if (existsSync(h.to)) renameSync(h.to, h.from); };
  process.on('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });
  try {
    for (const h of hidden) renameSync(h.from, h.to);
    ok('폰트 2개가 실제로 감춰짐', FONTS.every(f => !existsSync(join(FONT_DIR, f))));

    const r = spawnSync(process.execPath,
      [join(REPO, 'scripts', 'cardnews', 'render.mjs'), FIXTURE, join(TMP, 'nofont')],
      { cwd: REPO, encoding: 'utf8' });
    ok('renderCards 가 실패(exit≠0)', r.status !== 0, `exit=${r.status}`);
    const emitted = (() => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } })();
    ok('실패 사유가 폰트', !!emitted && emitted.ok === false && /폰트/.test(emitted.error ?? ''),
      r.stdout.trim().slice(-200));
    ok('두부 JPEG 을 산출하지 않음',
      !existsSync(join(TMP, 'nofont')) || readdirSync(join(TMP, 'nofont')).filter(f => f.endsWith('.jpg')).length === 0);
  } finally {
    restore();
  }
  ok('폰트 원복됨', FONTS.every(f => existsSync(join(FONT_DIR, f))));
}

// ─── (e) readJpegDims ─────────────────────────────────────────────────────────
console.log('\n(e) readJpegDims');
ok('렌더 산출물 치수 파싱', (() => {
  const d = readJpegDims(readFileSync(res.files[0]));
  return d && d.width === 1080 && d.height === 1350;
})());
ok('PNG 는 null', readJpegDims(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) === null);
ok('빈 버퍼는 null', readJpegDims(Buffer.alloc(0)) === null);
ok('SOI 만 있고 SOF 없으면 null', readJpegDims(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])) === null);
ok('DHT(C4) 를 SOF 로 오독하지 않음', (() => {
  // FFD8 | FFC4(DHT) len=11, 안에 가짜 치수 0x9999/0x8888 | FFC0(SOF0) len=17, 실제 1350×1080
  const buf = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xC4, 0x00, 0x0B, 0, 0, 0, 0x99, 0x99, 0, 0x88, 0x88, 0,
    0xFF, 0xC0, 0x00, 0x11, 0x08, 0x05, 0x46, 0x04, 0x38,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,          // SOF 잔여 페이로드(선언 길이 17 채움)
  ]);
  const d = readJpegDims(buf);
  return d && d.height === 0x0546 && d.width === 0x0438;
})());

// ─── (f) 게이트 실패 경로 — 삭제 금지 (AC-19) ─────────────────────────────────
console.log('\n(f) 게이트 실패 시 파일 보존');
{
  const six = join(TMP, 'six');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(six, { recursive: true });
  for (let i = 0; i < 6; i++) copyFileSync(res.files[i], join(six, `slide-0${i + 1}.jpg`));

  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'cardnews', 'gates.mjs'), six],
    { cwd: REPO, encoding: 'utf8' });
  ok('exit 1', r.status === 1, `exit=${r.status}`);
  // 계약: stdout 은 JSON 정확히 1줄(사람용 요약은 stderr). 그 계약 자체를 단언한다.
  const lines = r.stdout.trim().split('\n');
  ok('stdout 이 JSON 1줄', lines.length === 1, JSON.stringify(lines.slice(0, 3)));
  const out = JSON.parse(lines[0]);
  const count = out.checks.find(c => c.name === 'count');
  ok('count 체크 실패 + detail "6장"', count && count.pass === false && count.detail === '6장', JSON.stringify(count));
  ok('실행 후에도 파일 6개 그대로', readdirSync(six).length === 6, `${readdirSync(six).length}개`);

  // 치수 불일치 탐지 — JPEG 이지만 1080×1350 이 아닌 파일.
  const wrong = join(TMP, 'wrong');
  mkdirSync(wrong, { recursive: true });
  for (let i = 0; i < 7; i++) copyFileSync(res.files[i], join(wrong, `slide-0${i + 1}.jpg`));
  const w = judge(listSlides(wrong), { gates: { ...cfg.gates, height: 1920 } });
  ok('치수 다르면 dimensions 실패', w.ok === false && w.checks.find(c => c.name === 'dimensions').pass === false);
}

// ─── (g) AI 배경 생성 실패 → 그라데이션 폴백 ──────────────────────────────────
console.log('\n(g) 배경 생성 실패 시 무중단 폴백');
{
  const dir = join(TMP, 'genfail');
  let calls = 0;
  const r = await renderCards(script, {
    dir, cfg: cfgAi,
    generate: async () => { calls++; return { ok: false, error: 'stub 생성 실패' }; },
  });
  ok('생성기가 정확히 1회 호출됨(per_card=false)', calls === 1, `${calls}회`);
  ok('실패해도 ok=true', r.ok === true, JSON.stringify(r.reason ?? ''));
  ok('7장 그대로 산출', r.files.length === 7, `${r.files.length}장`);
  ok('mode=gradient + 사유 보존', r.background?.mode === 'gradient' && /stub 생성 실패/.test(r.background?.reason ?? ''),
    JSON.stringify(r.background));
  ok('폴백 산출물도 게이트 통과', judge(listSlides(dir), cfgAi).ok === true);

  // per_card 플래그가 죽은 설정이 아님을 확인 — 켜면 슬라이드마다 **다른 파일**로 생성한다.
  const { ensureBackgrounds } = await import('../cardnews/imagen.mjs');
  const seen = [];
  const perCard = await ensureBackgrounds(script, join(TMP, 'percard'),
    { ...cfgAi, imagen: { ...cfgAi.imagen, per_card: true } },
    { generate: async (_p, out) => { seen.push(out); return { ok: false, error: 'stub' }; } });
  ok('per_card=true 면 슬라이드 수만큼 생성 시도', seen.length === 7, `${seen.length}회`);
  ok('per_card 파일명이 슬라이드마다 다름', new Set(seen).size === 7, JSON.stringify(seen.map(s => s.split('/').pop())));
  ok('per_card 전부 실패해도 throw 없이 ok=false', perCard.ok === false && perCard.paths.every(p => p === null));
}

// ─── (h) 로컬 픽스처 배경 합성 — 게이트 + 실제 합성 픽셀 대비 ─────────────────
console.log('\n(h) 픽스처 배경 합성 (게이트 · 대비 ≥4.5:1)');
{
  const { launchArgs, launchEnv } = await import('../lib/browser-render.mjs');
  const { mkdirSync } = await import('node:fs');
  const browser = await chromium.launch({ headless: true, args: launchArgs(), env: launchEnv() });
  const dir = join(TMP, 'withbg');
  mkdirSync(dir, { recursive: true });

  try {
    // 픽스처: 1024² PNG — Gemini 응답과 같은 정사각(커버크롭 경로를 그대로 태운다).
    // **전면 순백**이 의도다. 실제 프롬프트는 muted·어두운 사진을 요구하므로 이보다 밝은
    // 배경은 나올 수 없다 — 여기서 4.5:1 이 나오면 어떤 사진에서도 나온다. 옅은 줄무늬는
    // 배경이 실제로 그려졌는지(단색 스크림과 구분되는지) 눈으로도 확인하기 위한 텍스처다.
    {
      const p = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
      await p.setContent(`<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden}
        .g{position:absolute;inset:0;background:repeating-linear-gradient(38deg,#ffffff 0 46px,#f5f8f2 46px 92px)}</style>
        <div class="g"></div>`);
      await p.screenshot({ path: join(dir, 'bg.png'), type: 'png' });
      await p.close();
    }
    ok('픽스처 PNG 생성됨', existsSync(join(dir, 'bg.png')) && readFileSync(join(dir, 'bg.png')).length > 1000);

    // 디스크 캐시가 있으므로 생성기는 호출되지 않아야 한다 = 네트워크 0.
    let calls = 0;
    const r = await renderCards(script, {
      dir, cfg: cfgAi,
      generate: async () => { calls++; return { ok: false, error: '캐시가 있는데 생성 시도' }; },
    });
    ok('캐시 히트 — 생성기 미호출', calls === 0, `${calls}회`);
    ok('ok=true', r.ok === true, JSON.stringify(r.reason ?? ''));
    ok('mode=ai, 7슬라이드 적용', r.background?.mode === 'ai' && r.background?.slides === 7, JSON.stringify(r.background));
    ok('신규 생성 0장(캐시)', r.background?.generated === 0, JSON.stringify(r.background));
    ok('전부 1080×1350', r.dims.every(d => d && d.width === 1080 && d.height === 1350), JSON.stringify(r.dims));
    ok('오버플로 0 유지', r.overflow.every(o => o === false), JSON.stringify(r.overflow));
    ok('게이트 통과', judge(listSlides(dir), cfgAi).ok === true);

    const maxB = Math.max(...r.bytes);
    ok(`파일당 ≤8MB (최대 ${Math.round(maxB / 1024)}KB)`, maxB <= cfgAi.gates.max_bytes, `${maxB}B`);
    console.log(`  [INFO] 배경 합성 슬라이드 바이트: ${r.bytes.join(', ')} (평균 ${Math.round(r.bytes.reduce((a, b) => a + b, 0) / r.bytes.length / 1024)}KB, 상한 ${Math.round(cfgAi.gates.max_bytes / 1024)}KB)`);

    // ── 🔴 배경이 **실제로 보이는가** ────────────────────────────────────────
    // 이 단언이 없으면 배경이 통째로 날아가도 테스트는 오히려 더 잘 통과한다(스크림만 남아
    // 카드가 더 어두워지므로 대비는 올라간다). 실제로 `url("…")` 의 큰따옴표가 style 속성을
    // 끊어 배경이 사라진 채 전부 초록불이 뜬 적이 있다. 순백 픽스처는 스크림을 통과해도
    // 그라데이션보다 훨씬 밝아야 한다 — 그 차이를 직접 잰다.
    const { slideHtmls, computeBackdrops } = await import('../cardnews/render.mjs');
    const bgUri = 'data:image/png;base64,' + readFileSync(join(dir, 'bg.png')).toString('base64');
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    // renderCards 와 **같은 경로**로 알파를 역산한다 — 테스트가 다른 값을 쓰면 측정 의미가 없다.
    const backdrops = await computeBackdrops(page, new Array(7).fill(bgUri), cfgAi);
    const htmls = slideHtmls(script, cfgAi, backdrops);
    console.log(`  [INFO] 순백 픽스처 역산 알파 ${backdrops[0].alpha.toFixed(3)} (측정 블록 rgb ${backdrops[0].probe.map(Math.round).join(',')})`);
    ok('순백 픽스처는 상한 가까이 덮는다(적응형이 작동)', backdrops[0].alpha > 0.7, `alpha=${backdrops[0].alpha}`);

    /** 글자·배지를 모두 숨기고 찍은 화면의 평균 상대휘도 = 순수 합성 배경. */
    const bgOnlyLuma = async (html) => {
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await page.evaluate(async () => {
        const el = document.querySelector('.bg');
        const m = el && /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
        if (!m) return;
        const im = new Image(); im.src = m[1];
        try { await im.decode(); } catch { /* noop */ }
      });
      await page.addStyleTag({ content: '.stage,.pill,.step{visibility:hidden}' });
      const shot = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1350 } });
      return page.evaluate(async (u) => {
        const im = new Image(); im.src = u; await im.decode();
        const cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(im, 0, 0);
        const rel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        let sum = 0;
        for (let k = 0; k < d.length; k += 4) sum += 0.2126 * rel(d[k]) + 0.7152 * rel(d[k + 1]) + 0.0722 * rel(d[k + 2]);
        return sum / (d.length / 4);
      }, 'data:image/png;base64,' + shot.toString('base64'));
    };

    const lumaWith = await bgOnlyLuma(htmls[0]);
    const lumaWithout = await bgOnlyLuma(slideHtmls(script, cfg, null)[0]);
    // 임계 1.5 는 두 실측 사이에 있다: 배경 정상 = 1.84배(순백 픽스처, 스크림 통과 후),
    // 배경 소실 = **1 미만**(사진이 없으면 스크림이 그라데이션을 덮어 오히려 어두워진다).
    // 스크림이 무거워야 4.5:1 이 나오므로 배수 자체는 크지 않다 — 방향과 여유가 판별력이다.
    console.log(`  [INFO] 배경 평균휘도 — 사진 합성 ${lumaWith.toFixed(4)} vs 그라데이션 ${lumaWithout.toFixed(4)} (${(lumaWith / lumaWithout).toFixed(2)}배)`);
    ok('순백 픽스처가 스크림을 뚫고 실제로 보인다(그라데이션 대비 1.5배 이상 밝음)',
      lumaWith > lumaWithout * 1.5, `${lumaWith.toFixed(4)} vs ${lumaWithout.toFixed(4)}`);

    // ── 실제 합성 픽셀 대비 ──────────────────────────────────────────────────
    // 글자 자체가 밝아 글자 픽셀을 섞으면 측정이 무의미해진다. 그래서 **글자만 숨기고**
    // 같은 품질로 다시 찍어, "글자가 앉을 자리의 합성 배경"만 읽는다. 가정한 배경색이 아니라
    // JPEG 압축까지 통과한 진짜 픽셀이다.
    const worstContrastOf = async (slides) => {
    const ratios = [];
    for (let i = 0; i < slides.length; i++) {
      await page.setContent(slides[i], { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await page.evaluate(async () => {
        const el = document.querySelector('.bg');
        const m = el && /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
        if (!m) return;
        const im = new Image(); im.src = m[1];
        try { await im.decode(); } catch { /* noop */ }
      });
      // 글자 사각형 + 각자의 실제 색(표지 서브카피만 색이 달라 셀렉터로 뭉뚱그리면 틀린다)
      const texts = await page.evaluate(() => [...document.querySelectorAll(`.stage .h, .stage .b, .stage div[style*="color"], .step`)]
        .filter(e => e.textContent.trim())
        .map(e => {
          const r = e.getBoundingClientRect(), c = getComputedStyle(e).color.match(/\d+/g).map(Number);
          return { x: r.x, y: r.y, w: r.width, h: r.height, rgb: [c[0], c[1], c[2]] };
        }));
      await page.addStyleTag({ content: '.stage,.step{visibility:hidden}' });
      const shot = await page.screenshot({ type: 'jpeg', quality: r.quality, clip: { x: 0, y: 0, width: 1080, height: 1350 } });

      const lums = await page.evaluate(async ({ uri, boxes }) => {
        const im = new Image(); im.src = uri; await im.decode();
        const cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(im, 0, 0);
        const rel = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        return boxes.map(b => {
          const x = Math.max(0, Math.round(b.x)), y = Math.max(0, Math.round(b.y));
          const w = Math.min(cv.width - x, Math.round(b.w)), h = Math.min(cv.height - y, Math.round(b.h));
          if (w <= 0 || h <= 0) return 0;
          const d = cx.getImageData(x, y, w, h).data;
          let max = 0;
          for (let k = 0; k < d.length; k += 4) {
            const L = 0.2126 * rel(d[k]) + 0.7152 * rel(d[k + 1]) + 0.0722 * rel(d[k + 2]);
            if (L > max) max = L;
          }
          return max;
        });
      }, { uri: 'data:image/jpeg;base64,' + shot.toString('base64'), boxes: texts });

      texts.forEach((t, k) => ratios.push({
        slide: i + 1,
        ratio: contrastRatio(srgbLuminance(...t.rgb), lums[k]),
      }));
    }
      return { worst: ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a)), n: ratios.length };
    };

    const white = await worstContrastOf(htmls);
    console.log(`  [INFO] 순백 배경 — 텍스트 ${white.n}개 실측, 최저 대비 ${white.worst.ratio.toFixed(2)}:1 (슬라이드 ${white.worst.slide})`);
    ok(`최악(순백) 배경에서도 전 텍스트 대비 ≥4.5:1 — 실측 최저 ${white.worst.ratio.toFixed(2)}:1`,
      white.worst.ratio >= 4.5, JSON.stringify(white.worst));
    ok('측정 대상이 실제로 존재(빈 측정 아님)', white.n >= 14, `${white.n}개`);

    // ── 어두운 사진에서는 스크림이 알아서 얇아진다 ──────────────────────────
    // 이게 적응형의 존재 이유다. 고정 알파(순백 기준 0.72)를 쓰면 실제로 오는 어두운 사진
    // (프롬프트에 "dark moody tones" 가 강제로 붙는다)이 통째로 뭉개져 그냥 검은 카드가 된다.
    // 그래도 대비는 계속 지켜져야 하므로 같은 실측을 다시 돌린다.
    {
      const p = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
      await p.setContent(`<style>html,body{margin:0;width:1024px;height:1024px;overflow:hidden}
        .g{position:absolute;inset:0;background:linear-gradient(160deg,#243040 0%,#141a24 55%,#0c1016 100%)}</style>
        <div class="g"></div>`);
      const darkPng = await p.screenshot({ type: 'png' });
      await p.close();

      const darkBd = await computeBackdrops(page, new Array(7).fill('data:image/png;base64,' + darkPng.toString('base64')), cfgAi);
      console.log(`  [INFO] 어두운 픽스처 역산 알파 ${darkBd[0].alpha.toFixed(3)} (순백 ${backdrops[0].alpha.toFixed(3)})`);
      ok('어두운 사진에는 스크림을 훨씬 얇게 — 사진이 살아남는다',
        darkBd[0].alpha < backdrops[0].alpha - 0.3, `dark=${darkBd[0].alpha.toFixed(3)} white=${backdrops[0].alpha.toFixed(3)}`);

      const dark = await worstContrastOf(slideHtmls(script, cfgAi, darkBd));
      console.log(`  [INFO] 어두운 배경 — 최저 대비 ${dark.worst.ratio.toFixed(2)}:1 (슬라이드 ${dark.worst.slide})`);
      ok(`스크림이 얇아져도 대비 ≥4.5:1 — 실측 최저 ${dark.worst.ratio.toFixed(2)}:1`,
        dark.worst.ratio >= 4.5, JSON.stringify(dark.worst));
    }
    await page.close();
  } finally {
    await browser.close().catch(() => {});
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n결과: ${passN} PASS / ${failN} FAIL`);
process.exit(failN === 0 ? 0 : 1);
