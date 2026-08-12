import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/** @type {import('eslint').Linter.Config[]} */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-plugin-react-hooks v7 (shipped with eslint-config-next 16) promotes
    // these to errors. They flag pre-existing component patterns unrelated to the
    // Next 16 / React 19 upgrade — keep them as warnings so the upgrade stays
    // isolated; address the underlying patterns separately.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  {
    // ── Modernist Kit 가드 (편집 중 즉시 피드백) ────────────────────────────
    // 전수 검사는 `npm run test:design` 이 한다. 여기서는 되돌리기 쉬운 실수를
    // 편집기에서 바로 잡아준다. 규칙 근거: /DESIGN.md §0 · §12.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/test/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@radix-ui/themes', message: 'Radix Themes 제거됨 — globals.css 키트 클래스를 쓰세요 (/DESIGN.md §12).' },
          { name: 'styled-components', message: 'CSS-in-JS 금지 — 키트 클래스를 쓰세요 (/DESIGN.md §0).' },
        ],
        patterns: [
          { group: ['@radix-ui/themes/*', '@emotion/*', '@stitches/*'], message: 'UI 라이브러리 추가 금지 (/DESIGN.md §0).' },
        ],
      }],
      'no-restricted-syntax': ['error',
        {
          // Tailwind 반응형·상태 접두사는 오탐 없이 잡힌다.
          selector: 'JSXAttribute[name.name=/^className$/] Literal[value=/(^|\\s)(sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover):/]',
          message: 'Tailwind 접두사 클래스 금지 — 키트 클래스만 사용 (/DESIGN.md §12.2).',
        },
        {
          selector: 'JSXAttribute[name.name=/^className$/] Literal[value=/(^|\\s)prose(-\\w+)?(\\s|$)/]',
          message: 'prose 금지 — 본문은 .article 을 쓰세요 (/DESIGN.md §11.3).',
        },
        {
          // 토큰 사용(`borderRadius: 'var(--radius-lg)'`)은 정상이므로 제외한다.
          selector: 'Property[key.name="borderRadius"][value.type="Literal"][value.value!=/^var\\(--radius-/]',
          message: 'borderRadius 는 var(--radius-sm|md|lg|pill) 만 (/DESIGN.md 규칙 2).',
        },
      ],
    },
  },
];

export default eslintConfig;
