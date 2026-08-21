/**
 * eslint.config.js — 정적 분석 최소 규칙셋 (Phase 0)
 *
 * 목적은 스타일 통일이 아니라 **런타임 이전에 잡히는 결함**을 잡는 것이다.
 * 이 저장소는 51,837줄 무타입 JS 인데 정적 분석이 0종이었고, CI 도 테스트를
 * 트리거하지 않아 오타 하나가 cron 야간 실행에서야 드러났다.
 *
 * 정책:
 *   - error  = CI 를 red 로 만든다. 거의 확실한 결함만 여기 둔다.
 *   - warn   = 보고만 한다. 정리 대상이지만 발행을 막지는 않는다.
 *   - off    = 이 저장소의 의도적 관용구와 충돌하는 것(예: 빈 catch).
 *
 * 실행: npm run lint  /  npm run lint:fix
 */

// Node 20 ESM 전역. `globals` 패키지를 추가하는 대신 명시한다 — 의존성 하나를
// 아끼려는 것도 있지만, 무엇이 전역으로 허용되는지가 파일에 드러나는 편이 낫다.
const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
  TextDecoder: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
  fetch: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly',
  FormData: 'readonly', Blob: 'readonly', File: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly',
  queueMicrotask: 'readonly', structuredClone: 'readonly',
  crypto: 'readonly', performance: 'readonly', globalThis: 'readonly',
  Intl: 'readonly', WebAssembly: 'readonly',
  // Node 20+ 전역(undici). shorts/tts/edge.mjs·recon/recon.mjs 가 typeof 가드와
  // 함께 실제로 쓴다.
  WebSocket: 'readonly',
};

// Playwright page.evaluate() 콜백 안은 브라우저 컨텍스트다.
const browserGlobals = {
  document: 'readonly', window: 'readonly', navigator: 'readonly',
  location: 'readonly', getComputedStyle: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly',
  CustomEvent: 'readonly', Event: 'readonly', requestAnimationFrame: 'readonly',
  Image: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**', 'vendor/**', '.mock-out/**', 'runs/**',
      'state/**', 'published/**', 'benchmark/**', 'repo/**',
      'reference/**', 'docs/**', 'supabase/**', '.omc/**', '.omx/**',
    ],
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // ── error: 거의 확실한 결함 ───────────────────────────────────────────
      // 오타·import 누락. 이 저장소에서 가장 값진 규칙이다.
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',            // 설정 객체에서 키가 조용히 덮이는 사고
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-binary-expression': 'error',
      'no-dupe-else-if': 'error',
      // no-sparse-arrays / require-atomic-updates 는 error 로 두려 했으나
      // 실측(2026-08-21 전수 실행)에서 진양성 0·위양성 13 이었다. 근거는 아래 warn 절.
      // switch 폴스루는 게이트 판정 로직에서 실제 오판을 낳는다.
      'no-fallthrough': 'error',

      // 모듈 평가 시점에 실행되는 코드가 아래에서 const 로 정의된 값을 참조하면
      // TDZ 로 모듈이 통째로 죽는다. 2026-08-21 에 **두 번** 당했다(채널 lib 과
      // shorts/script) — 사람 기억에 맡기지 말고 규칙으로 막는다.
      // 함수 선언은 호이스팅되므로 제외한다(그건 이 저장소의 정상 관용구다).
      'no-use-before-define': ['error', {
        functions: false, classes: true, variables: true, allowNamedExports: true,
      }],

      // ── warn: 정리 대상이나 발행을 막지 않음 ─────────────────────────────
      // 죽은 import·잘못된 구조분해가 여기서 드러난다. 양이 많아 먼저 warn.
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',            // catch (e) 미사용은 이 저장소의 관용구
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // 실측으로 강등한 둘. "규칙이 유명하니까 error" 가 아니라 이 저장소에서
      // 실제로 무엇을 잡았는지로 정했다.
      //
      // no-sparse-arrays (위양성 9/9): `m.match(re) || [, '']` 는 정규식 결과의
      //   [0](전체 매치)을 일부러 비우고 [1] 기본값만 주는 의도적 관용구다.
      //   코드는 옳다. 다만 `[undefined, '']` 로 쓰면 의도가 드러나므로 정리 대상.
      'no-sparse-arrays': 'warn',
      //
      // require-atomic-updates (위양성 4/4): JS 는 단일 스레드라 지역 플래그의
      //   await 전후 대입에 실제 경쟁이 없다. agent-runner 의 `flushing` 은
      //   올바른 single-flight 구현이고, 나머지 셋은 테스트의 globalThis.fetch
      //   스텁과 process.exitCode 대입이다.
      'require-atomic-updates': 'warn',
      'no-useless-escape': 'warn',       // 정규식이 많아 오탐 여지 → warn

      // ── off: 의도적 관용구와 충돌 ────────────────────────────────────────
      'no-prototype-builtins': 'off',
      'no-control-regex': 'off',         // 제어문자 정규식을 실제로 쓴다
    },
  },
  {
    // Playwright 브라우저 컨텍스트를 쓰는 파일만 브라우저 전역 허용
    files: [
      'scripts/shorts/slides.mjs',
      'scripts/cardnews/render.mjs',
      'scripts/hub/server.mjs',
      'scripts/test/cardnews-render.test.mjs',
      'scripts/test/hub-dashboard-xss.test.mjs',
    ],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },
];
