/**
 * lib/browser-render.mjs — headless chromium 렌더 공용 조각 (계획 §3.8, R3-lite)
 *
 * 기존 3개 사본(shorts/slides.mjs:19, crosspub/browser/context.mjs:21,
 * render/screenshot.mjs:30)의 이관 대상. 이관은 각 파이프라인의 별도 스토리 —
 * 이 모듈이 첫 단계다. 현재 소비자는 `cardnews/render.mjs` 하나뿐이며,
 * 위 3개 파일은 이 스토리에서 **수정하지 않는다**(diff 0줄).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../');

/**
 * sudo 없는 WSL 우회 — vendor/chromium-libs 의 .so 경로를 `:` 로 이어 반환.
 * 없으면 null(시스템 라이브러리로 뜨는 환경).
 */
export function vendorLdPath() {
  const base = join(REPO_ROOT, 'vendor', 'chromium-libs', 'root');
  if (!existsSync(base)) return null;
  const parts = [
    join(base, 'usr', 'lib', 'x86_64-linux-gnu'),
    join(base, 'lib', 'x86_64-linux-gnu'),
  ].filter(existsSync);
  return parts.length ? parts.join(':') : null;
}

/**
 * 한국어 폰트 @font-face 임베드(base64). 최초 1회 캐시.
 *
 * ⚠ headless chromium 에는 시스템 한글 폰트가 없다. 이 CSS 가 비면 본문이 전부
 * 두부(□)로 렌더되고 스크린샷에 그대로 박힌다 — 호출자는 빈 문자열을 **즉시 실패**로
 * 다뤄야 한다(계획 §3.8 AC-5).
 */
let _fontCss = null;
export function fontFaceCss() {
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

/** chromium launch 인자. `--force-color-profile=srgb` 는 색 재현 고정(스펙 58행). */
export function launchArgs() {
  return ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'];
}

/** vendorLdPath() 를 LD_LIBRARY_PATH 에 prepend 한 process.env 사본. */
export function launchEnv() {
  const vendor = vendorLdPath();
  if (!vendor) return process.env;
  return {
    ...process.env,
    LD_LIBRARY_PATH: [vendor, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };
}
