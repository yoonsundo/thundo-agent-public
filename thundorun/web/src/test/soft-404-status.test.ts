/**
 * soft-404-status — 없는 글이 "본문은 404 화면인데 HTTP 200" 이 되지 않게 잠근다.
 *
 * 🔴 2026-09-07 실측(라이브·로컬 양쪽):
 *      GET /blog/definitely-not-a-real-slug-xyz   → 200  (본문은 404 화면)
 *      GET /notices/99999999                      → 200  (같은 증상)
 *      GET /nope-xyz  (라우트 자체가 없음)        → 404  (정상)
 *    원인은 `notFound()` 누락이 아니었다 — 두 페이지 모두 `if (!post) notFound()` 가 있었다.
 *    범인은 **`(site)/loading.tsx`** 였다. loading.tsx 는 그 세그먼트 아래 전체에 Suspense
 *    경계를 만들고, Next 는 골격을 먼저 흘려보내며 응답 헤더를 확정한다. 그 뒤에 notFound()
 *    가 던져져도 상태줄은 이미 `200 OK` 다.
 *    → 그 파일을 지우고 다시 빌드하자 둘 다 404 로 돌아왔다(실행 검증).
 *
 * 구글에게 soft-404 는 "없는 페이지를 있다고 우기는 사이트" 신호다. 색인 예산을 갉아먹고,
 * 미승인 글 주소가 200 을 주면 승인 관문이 밖에서는 없는 것처럼 보인다.
 *
 * 이 테스트가 지키는 규칙: **notFound() 를 부르는 라우트의 조상 세그먼트에 loading.tsx 를
 * 두지 않는다.** 로딩 골격이 필요하면 그 세그먼트 아래로 내리거나(다른 형제 세그먼트),
 * 페이지 안 `<Suspense>` 로 범위를 좁힌다(/blog 목록이 그렇게 한다).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

const APP_ROOT = join(process.cwd(), 'src', 'app');

/** src/app 아래 모든 파일 경로(절대). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(APP_ROOT);

/** notFound() 를 실제로 부르는 라우트 파일들. 주석 속 언급은 세지 않는다. */
const notFoundRoutes = files.filter((f) => {
  if (!/\.tsx?$/.test(f)) return false;
  const src = readFileSync(f, 'utf8');
  // 주석 줄을 걷어낸 뒤 호출만 본다(이 규칙을 설명하는 주석이 스스로를 걸지 않게).
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /\bnotFound\(\)/.test(code);
});

/** 경로의 조상 디렉터리 목록(자기 자신 포함, src/app 까지). */
function ancestors(file: string): string[] {
  const out: string[] = [];
  let dir = dirname(file);
  for (;;) {
    out.push(dir);
    if (dir === APP_ROOT) break;
    const parent = dirname(dir);
    if (parent === dir) break;   // 루트 도달 — 방어
    dir = parent;
  }
  return out;
}

describe('soft-404 — 없는 글은 404 를 준다', () => {
  it('notFound() 를 부르는 라우트가 실제로 있다(이 테스트의 전제)', () => {
    // 전제가 사라지면 아래 검사가 항상 통과하는 빈 껍데기가 된다.
    expect(notFoundRoutes.length).toBeGreaterThan(0);
  });

  it.each(notFoundRoutes.map((f) => relative(process.cwd(), f)))(
    '%s 위쪽에 loading.tsx 가 없다 — 있으면 응답이 200 으로 굳는다',
    (rel) => {
      const full = join(process.cwd(), rel.split('/').join(sep));
      const offenders = ancestors(full)
        .map((d) => join(d, 'loading.tsx'))
        .filter(existsSync)
        .map((f) => relative(process.cwd(), f));
      expect(
        offenders,
        `이 loading.tsx 들이 Suspense 경계를 만들어 ${rel} 의 notFound() 를 200 으로 만든다`,
      ).toEqual([]);
    },
  );

  it('블로그 상세는 notFound() 를 부른다 — 관문이 통째로 사라지면 잡아야 한다', () => {
    const src = readFileSync(join(APP_ROOT, '(site)', 'blog', '[slug]', 'page.tsx'), 'utf8');
    expect(src).toMatch(/if \(!post\) notFound\(\)/);
  });

  it('/blog 목록의 로딩 골격은 페이지 안 Suspense 다 — 자식(상세)을 덮지 않는다', () => {
    const src = readFileSync(join(APP_ROOT, '(site)', 'blog', 'page.tsx'), 'utf8');
    expect(src).toContain('<Suspense');
    expect(existsSync(join(APP_ROOT, '(site)', 'blog', 'loading.tsx'))).toBe(false);
  });
});
