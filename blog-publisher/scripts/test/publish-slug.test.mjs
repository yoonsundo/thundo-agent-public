#!/usr/bin/env node
/**
 * publish-slug.test.mjs — 발행 경로 조립의 slug 검증 회귀 테스트.
 *
 * 배경(2026-08-19 감사): `published/<날짜>-<slug>.md` 의 slug 은 LLM 이 쓴 초안 frontmatter 에서
 * 그대로 왔고 검증이 없었다. `slug: ../../../../tmp/x` 가 path.join 정규화를 타고 레포 밖으로
 * 파일을 쓴다는 것을 실측으로 확인했다. 그 회귀를 막는다.
 */
import { isSafeSlug, assertSafeSlug } from '../lib/slug.mjs';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n[1] 정상 slug 는 통과한다(기존 발행물 형식)');
for (const s of ['claude-code-hooks-precommit-validation', 'ai-agent-2026', 'a']) {
  ok(`허용: ${s}`, isSafeSlug(s));
}

console.log('\n[2] 경로 이탈·구분자·제어문자는 거부한다');
for (const s of ['../../../../tmp/x', '../../.claude/CLAUDE', 'a/b', 'a\\b', '..', '.', '', 'UPPER', 'has space', '한글']) {
  ok(`거부: ${JSON.stringify(s)}`, !isSafeSlug(s));
}

console.log('\n[3] assertSafeSlug 는 거부 시 throw 하고 통과 시 값을 돌려준다');
ok('통과 시 값 반환', assertSafeSlug('good-slug') === 'good-slug');
let threw = false;
try { assertSafeSlug('../../etc/x', '발행 slug'); } catch { threw = true; }
ok('거부 시 throw', threw);

console.log('\n[4] 탈출이 실제로 가능했음을 경로 계산으로 확인(가드의 존재 이유)');
const escaped = join(ROOT, `published/2026-08-19-${'../../../../tmp/x'}.md`);
ok('가드 없이는 레포 밖 경로가 생성된다', !escaped.startsWith(join(ROOT, 'published')), escaped);

console.log('\n[5] 발행 경로 3곳이 모두 가드를 호출한다');
for (const f of ['scripts/publish-pending-drafts.mjs', 'scripts/daily-real-publish.mjs', 'scripts/run-lion.mjs']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  ok(`${f} 에 assertSafeSlug 배선`, /assertSafeSlug\(/.test(src) && /from '\.\/lib\/slug\.mjs'/.test(src));
}

console.log(`\n발행 slug 가드: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
