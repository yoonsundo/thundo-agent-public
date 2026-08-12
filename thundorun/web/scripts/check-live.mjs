/**
 * check-live.mjs — 배포된 사이트를 실제 브라우저로 열어 키트 적용을 실측한다.
 *
 * 로컬 E2E 는 크리덴셜이 없어 데이터가 비어 있다. 그래서 **데이터가 많을 때만
 * 드러나는 결함**을 못 잡는다 — 실제로 `/videos` 의 재생 배지가 `.btn-primary` 라
 * 영상 43개에서 강조색이 도배된 것을 이 검사가 배포 후에 처음 발견했다.
 *
 *   node scripts/check-live.mjs                 # https://www.thundo.kr
 *   node scripts/check-live.mjs https://…       # 다른 배포본(프리뷰 등)
 *
 * WSL 처럼 chromium 공유 라이브러리를 설치할 수 없는 환경은 CHROMIUM_LIB_DIR 로
 * deb 를 풀어둔 경로를 넘기면 LD_LIBRARY_PATH 에 주입한다.
 */
import fs from 'node:fs';

const LIB_DIR =
  process.env.CHROMIUM_LIB_DIR ??
  '/home/user/th-team/blog-publisher/vendor/chromium-libs/root/usr/lib/x86_64-linux-gnu';
if (fs.existsSync(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = [LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const { chromium } = await import('playwright');

const BASE = (process.argv[2] ?? 'https://www.thundo.kr').replace(/\/$/, '');
const ROUTES = ['/', '/blog', '/videos', '/notices', '/login'];

/** 배포 환경에서 필연적으로 나는 잡음(우리 코드 문제가 아닌 것)만 무시한다. */
const IGNORE = [/favicon/i, /manifest/i, /40[34]/, /googletagmanager|vercel|analytics|gtag/i];

const browser = await chromium.launch();
let failures = 0;

for (const route of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.some((re) => re.test(m.text()))) errors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => {
    if (!IGNORE.some((re) => re.test(e.message))) errors.push(`pageerror: ${e.message.slice(0, 160)}`);
  });

  const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts.ready);

  const r = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/gu;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const emoji = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest('script,style,svg')) continue;
      for (const m of (n.nodeValue ?? '').matchAll(EMOJI)) emoji.add(m[0]);
    }
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      accent: cs.getPropertyValue('--color-accent').trim(),
      pretendard: document.fonts.check('16px "Pretendard Variable"'),
      archivo: document.fonts.check('16px Archivo'),
      emoji: [...emoji],
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      // 숨겨진 탭 패널 안의 버튼은 화면에서 경쟁하지 않는다 — 보이는 것만 센다.
      primaries: [...document.querySelectorAll('.btn-primary')].filter((el) => {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).length,
      unlabeled: [...document.querySelectorAll('button.btn-icon')].filter((b) => !b.getAttribute('aria-label')).length,
      // 콘텐츠 사진이 탈색됐는지 — 조상 어디에 필터가 걸려도 잡힌다(§12.11).
      // 소스에서 클래스를 지워도 다른 경로로 필터가 들어올 수 있어 렌더 결과를 본다.
      desaturated: [...document.querySelectorAll('img, iframe')].filter((el) => {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const f = getComputedStyle(n).filter;
          if (f && f !== 'none' && /grayscale\((?!0\b)/.test(f)) return true;
        }
        return false;
      }).length,
    };
  });

  const problems = [];
  if ((resp?.status() ?? 0) >= 400) problems.push(`HTTP ${resp?.status()}`);
  if (r.theme !== 'light') problems.push(`data-theme=${r.theme}`);
  if (r.bodyBg !== 'rgb(243, 242, 242)') problems.push(`body 배경 ${r.bodyBg}`);
  if (r.accent.toLowerCase() !== '#ec3013') problems.push(`accent ${r.accent}`);
  if (!r.pretendard) problems.push('Pretendard 미로드 — 한글이 시스템 폴백으로 떨어진다');
  if (!r.archivo) problems.push('Archivo 미로드');
  if (r.emoji.length) problems.push(`이모지 ${r.emoji.join('')} (규칙 8)`);
  if (!r.noOverflow) problems.push('가로 오버플로');
  if (r.primaries > 1) problems.push(`.btn-primary ${r.primaries}개 — 화면당 1개 (규칙 4.4)`);
  if (r.unlabeled) problems.push(`aria-label 없는 아이콘 버튼 ${r.unlabeled}개 (§8)`);
  if (r.desaturated) problems.push(`흑백 처리된 사진·영상 ${r.desaturated}개 — 콘텐츠는 원색 (§12.11)`);
  if (errors.length) problems.push(`콘솔 에러: ${errors.join(' | ')}`);

  if (problems.length) failures++;
  console.log(
    `${problems.length ? 'FAIL' : ' OK '} ${route}  ${problems.join(' / ') || '토큰·폰트·이모지·오버플로·강조·접근성 정상'}`,
  );
  await page.close();
}

await browser.close();
console.log(failures ? `\n실패 ${failures}건 — 배포본이 키트 계약을 어겼다.` : '\n전 라우트 정상');
process.exit(failures ? 1 : 0);
