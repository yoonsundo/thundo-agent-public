import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import { E2E_NEXTAUTH_SECRET } from './e2e/secret';

/**
 * playwright.config.ts — 실제 브라우저로 키트 적용을 실측한다.
 *
 * 이 박스(WSL)는 sudo 가 없어 chromium 의 시스템 공유 라이브러리를 설치할 수 없다.
 * deb 를 풀어둔 디렉터리를 LD_LIBRARY_PATH 로 주입해 우회한다(CHROMIUM_LIB_DIR).
 * CI/다른 머신에서는 해당 경로가 없으면 아무 것도 하지 않는다.
 */
const LIB_DIR =
  process.env.CHROMIUM_LIB_DIR ??
  '/home/user/th-team/blog-publisher/vendor/chromium-libs/root/usr/lib/x86_64-linux-gnu';
if (fs.existsSync(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = [LIB_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    // iPhone 13 프리셋은 webkit 을 요구한다(이 박스엔 chromium 만 있다) → chromium 모바일 프리셋 사용.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  // dev 서버(`next dev --webpack`)는 이 박스에서 HMR 웹소켓 핸드셰이크가 실패하며
  // 하이드레이션까지 함께 죽는다(클릭이 안 먹는다 — 앱 버그가 아니라 환경 문제).
  // 그래서 E2E 는 프로덕션 빌드를 띄워 실측한다. `npm run test:e2e` 가 build 를 먼저 돌린다.
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      // 프로덕션 기동 가드(`lib/auth.ts`)가 32바이트 이상 시크릿을 요구한다.
      // 소스에 값을 박지 않는다(커밋물에 시크릿 형태 문자열이 남고 실 설정으로 복사될 위험).
      // 세션 쿠키를 직접 서명하는 스펙과 **같은 값**이어야 하므로 무작위가 아니라 파생 상수를 쓴다.
      NEXTAUTH_SECRET: E2E_NEXTAUTH_SECRET,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ?? `http://127.0.0.1:${PORT}`,
    },
  },
});
