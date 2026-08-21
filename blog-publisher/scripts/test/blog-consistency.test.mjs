#!/usr/bin/env node
/**
 * scripts/test/blog-consistency.test.mjs — 블로그 3저장소 정합 점검 단위테스트
 *
 * 이 도구가 지켜야 할 성질은 "많이 찾는 것" 이 아니라 **거짓 안심을 주지 않는 것**이다.
 * 특히 Supabase 크리덴셜이 없을 때 로컬 폴백 로그를 DB 로 착각하게 만들면,
 * "다 들어가 있다" 는 잘못된 결론이 나온다 — 그걸 테스트로 막는다.
 *
 * 실행: node --test scripts/test/blog-consistency.test.mjs  (npm run test:blog-consistency)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  slugFromFilename, slugFromFrontmatter, readPublished, readDbSlugs,
  readPublishedIndex, checkConsistency,
} from '../lib/blog-consistency.mjs';
import { blogLifecycle, BLOG_STATES } from '../kernel/lifecycle.mjs';

let DIR;
before(() => { DIR = mkdtempSync(join(tmpdir(), 'blogcheck-')); });
after(()  => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 무시 */ } });

function makePublished(files) {
  const dir = join(DIR, `pub-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}
const doc = (slug, body = '본문') => `---\ntitle: 제목\nslug: ${slug}\n---\n${body}`;

describe('slug 추출', () => {
  test('파일명에서 날짜 접두를 벗긴다', () => {
    assert.equal(slugFromFilename('2026-08-21-my-post.md'), 'my-post');
    assert.equal(slugFromFilename('no-date.md'), 'no-date');
  });

  test('frontmatter 의 slug 를 읽는다 (따옴표 유무 무관)', () => {
    assert.equal(slugFromFrontmatter(doc('abc')), 'abc');
    assert.equal(slugFromFrontmatter('---\nslug: "q-x"\n---\n본문'), 'q-x');
    assert.equal(slugFromFrontmatter('frontmatter 없음'), null);
  });
});

describe('저장소 읽기', () => {
  test('published/ 에서 파일명 slug 와 frontmatter slug 를 둘 다 돌려준다', () => {
    const dir = makePublished({ '2026-08-21-a.md': doc('a') });
    const [p] = readPublished(dir);
    assert.equal(p.fileSlug, 'a');
    assert.equal(p.fmSlug, 'a');
    assert.equal(p.date, '2026-08-21');
  });

  test('없는 디렉터리는 빈 배열 (예외를 던지지 않는다)', () => {
    assert.deepEqual(readPublished(join(DIR, '없음')), []);
  });

  test('없는 원장은 빈 객체', () => {
    assert.deepEqual(readPublishedIndex({ path: join(DIR, '없음.json') }), {});
  });

  /** 이 테스트가 이 파일의 존재 이유다. */
  test('🔴 크리덴셜 없이 폴백 로그를 읽으면 db_source 로 반드시 밝힌다', () => {
    const p = join(DIR, 'fallback.jsonl');
    writeFileSync(p, JSON.stringify({ slug: 'x' }) + '\n', 'utf8');
    const r = readDbSlugs({ jsonlPath: p });
    assert.equal(r.db_source, 'local-fallback',
      '폴백을 supabase 로 표기하면 "DB 에 다 있다" 는 거짓 안심을 준다');
    assert.equal(r.slugs.has('x'), true);
  });

  test('파일 자체가 없으면 db_source=none', () => {
    assert.equal(readDbSlugs({ jsonlPath: join(DIR, '없음.jsonl') }).db_source, 'none');
  });

  test('깨진 줄은 건너뛰고 나머지를 읽는다', () => {
    const p = join(DIR, 'broken.jsonl');
    writeFileSync(p, `{"slug":"ok1"}\n깨진줄\n{"slug":"ok2"}\n`, 'utf8');
    const r = readDbSlugs({ jsonlPath: p });
    assert.deepEqual([...r.slugs].sort(), ['ok1', 'ok2']);
  });
});

describe('정합 대조', () => {
  const base = (over = {}) => checkConsistency({
    published: [{ filename: '2026-08-21-a.md', fileSlug: 'a', fmSlug: 'a', bytes: 10, date: '2026-08-21' }],
    db: { slugs: new Set(['a']), db_source: 'local-fallback', rows: 1 },
    index: { key1: { slug: 'a' } },
    ...over,
  });

  test('세 곳이 맞으면 지적이 없다', () => {
    const { findings: f } = base();
    for (const [k, v] of Object.entries(f)) assert.equal(v.length, 0, `${k} 가 비어야 한다`);
  });

  test('DB 에 없는 발행물을 잡는다', () => {
    const { findings } = base({ db: { slugs: new Set(), db_source: 'local-fallback', rows: 0 } });
    assert.deepEqual(findings.missing_in_db, ['a']);
  });

  test('원장에 없는 발행물을 잡는다', () => {
    assert.deepEqual(base({ index: {} }).findings.missing_in_index, ['a']);
  });

  test('DB 에만 있는 고아를 잡는다', () => {
    const { findings } = base({ db: { slugs: new Set(['a', 'ghost']), db_source: 'local-fallback', rows: 2 } });
    assert.deepEqual(findings.orphan_in_db, ['ghost']);
  });

  test('파일명 slug 와 frontmatter slug 가 어긋나면 잡는다', () => {
    const { findings } = base({
      published: [{ filename: '2026-08-21-a.md', fileSlug: 'a', fmSlug: 'b', bytes: 10, date: '2026-08-21' }],
      db: { slugs: new Set(['b']), db_source: 'local-fallback', rows: 1 },
      index: { k: { slug: 'b' } },
    });
    assert.equal(findings.slug_mismatch.length, 1);
    assert.equal(findings.slug_mismatch[0].frontmatter_slug, 'b');
  });

  test('빈 파일과 frontmatter 없는 파일을 잡는다', () => {
    const { findings } = base({
      published: [
        { filename: 'empty.md', fileSlug: 'empty', fmSlug: null, bytes: 0, date: null },
      ],
      db: { slugs: new Set(['empty']), db_source: 'local-fallback', rows: 1 },
      index: { k: { slug: 'empty' } },
    });
    assert.deepEqual(findings.empty_files, ['empty.md']);
    assert.deepEqual(findings.no_frontmatter, ['empty.md']);
  });

  test('db_source 를 요약에 그대로 실어 보낸다', () => {
    assert.equal(base().summary.db_source, 'local-fallback');
  });
});

describe('kernel — 블로그 수명주기', () => {
  test('상태 집합이 run-lion 의 outcome 과 일치한다', () => {
    for (const s of ['published', 'discarded', 'discarded_slug', 'discarded_budget']) {
      assert.ok(BLOG_STATES.includes(s), `${s} 가 상태 집합에 없다`);
    }
  });

  test('초안을 거치지 않고 바로 발행될 수 없다', () => {
    assert.equal(blogLifecycle.canTransition(null, 'published').ok, false);
  });

  test('slug 위반·예산 캡은 게이트 앞에서 걸리므로 시작 상태에서 바로 간다', () => {
    assert.equal(blogLifecycle.canTransition(null, 'discarded_slug').ok, true);
    assert.equal(blogLifecycle.canTransition(null, 'discarded_budget').ok, true);
  });

  test('재시도는 drafted 자기 전이로 표현된다', () => {
    assert.equal(blogLifecycle.canTransition('drafted', 'drafted').ok, true);
    assert.equal(blogLifecycle.canTransition('gate_passed', 'drafted').ok, true, '검증자 미통과 후 재시도');
  });

  test('발행·폐기는 전부 종단이다', () => {
    for (const s of ['published', 'discarded', 'discarded_slug', 'discarded_budget']) {
      assert.equal(blogLifecycle.isTerminal(s), true, `${s} 는 종단이어야 한다`);
      assert.equal(blogLifecycle.canTransition(s, 'drafted').ok, false);
    }
  });
});
