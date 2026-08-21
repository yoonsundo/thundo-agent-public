/**
 * server-client-boundary.test.ts — 서버 컴포넌트가 `'use client'` 모듈의 **함수**를 호출하지 않는지.
 *
 * 왜 이 테스트가 있나(2026-08-21 실장애):
 *   `BoardMeeting`(서버 컴포넌트)이 `BoardApprovalList`(`'use client'`)에서 `splitHeadline` 을
 *   가져다 서버 렌더 중에 호출했다. **빌드는 통과하고 요청 시점에 죽었다** —
 *   에이전트 일지(/reports)가 통째로 오류 화면이 됐다.
 *
 *     Attempted to call splitHeadline() from the server but splitHeadline is on the client.
 *
 *   `'use client'` 모듈의 export 는 서버에서 보면 실제 함수가 아니라 클라이언트 참조다.
 *   컴포넌트로 렌더하거나 props 로 넘기는 것만 되고, 호출하면 던진다.
 *
 * 이 테스트가 막는 것: 서버 컴포넌트가 client 모듈에서 **대문자로 시작하지 않는 이름**
 * (= 컴포넌트가 아닌 것)을 named import 하는 경우. 컴포넌트(default·PascalCase) import 는 정상이다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const isClientModule = (src: string) => /^\s*['"]use client['"]/.test(src);

/** `@/…` 별칭을 실제 파일 경로로. 확장자 후보를 순서대로 시도한다. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null;
  const base = join(SRC, spec.slice(2));
  for (const cand of [`${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    try { if (statSync(cand).isFile()) return cand; } catch { /* 다음 후보 */ }
  }
  return null;
}

describe('서버/클라이언트 경계', () => {
  it('서버 컴포넌트가 client 모듈에서 함수(비컴포넌트)를 가져오지 않는다', () => {
    const violations: string[] = [];

    for (const file of walk(SRC)) {
      if (file.includes(`${'/'}test${'/'}`)) continue;          // 테스트는 번들 대상이 아니다
      const src = readFileSync(file, 'utf8');
      if (isClientModule(src)) continue;                         // 클라이언트끼리는 정상

      // `import { a, b as c } from '@/…'` 형태만 본다(default import 는 컴포넌트라 정상).
      const re = /import\s*\{([^}]+)\}\s*from\s*['"](@\/[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const target = resolveAlias(m[2]);
        if (!target) continue;
        let targetSrc = '';
        try { targetSrc = readFileSync(target, 'utf8'); } catch { continue; }
        if (!isClientModule(targetSrc)) continue;

        for (const raw of m[1].split(',')) {
          const name = raw.split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '');
          if (!name) continue;
          if (raw.trim().startsWith('type ')) continue;          // 타입은 런타임에 사라진다
          if (/^[A-Z]/.test(name)) continue;                     // 컴포넌트는 렌더 가능하므로 허용
          violations.push(
            `${file.replace(SRC, 'src')} → ${m[2]} 의 '${name}' ` +
            `(client 모듈의 비컴포넌트 export 를 서버에서 호출하면 요청 시점에 던진다)`,
          );
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('splitHeadline 은 client 경계 밖(lib)에 있다', () => {
    const lib = readFileSync(join(SRC, 'lib/board-text.ts'), 'utf8');
    expect(isClientModule(lib)).toBe(false);
    expect(lib).toContain('export function splitHeadline');
  });
});
