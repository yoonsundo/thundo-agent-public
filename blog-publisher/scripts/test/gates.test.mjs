#!/usr/bin/env node
/**
 * scripts/test/gates.test.mjs — 게이트 판정 단위테스트
 *
 * Phase 3(F-07) 이전에는 이 파일을 쓸 수 없었다. 게이트가 `main()` 안에서 argv 를 읽고
 * stdout 에 쓰고 `process.exit` 으로 끝났기 때문에, 판정 하나를 확인하려면 **프로세스를
 * 띄워야** 했다(그래서 기존 테스트 52개 중 19개가 child_process 를 쓴다).
 * 이제 각 게이트가 `evaluate(draftPath)` 를 export 하므로 직접 부를 수 있다.
 *
 * 여기서 고정하는 것은 **경계**다 — 통과/차단이 갈리는 지점. 중간값은 회귀를 못 잡는다.
 *
 * 실행: node --test scripts/test/gates.test.mjs   (npm run test:gates)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluate as length }      from '../gates/check-length.mjs';
import { evaluate as empty }       from '../gates/check-empty.mjs';
import { evaluate as banned }      from '../gates/check-banned.mjs';
import { evaluate as renderFit }   from '../gates/check-render-fit.mjs';
import { evaluate as internalDup } from '../gates/check-internal-dup.mjs';
import { GateError }               from '../gates/lib/gate-cli.mjs';

let DIR;
before(() => { DIR = mkdtempSync(join(tmpdir(), 'gates-test-')); });
after(()  => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ } });

/** 초안 파일을 하나 만들고 경로를 돌려준다. */
function draft(name, body, fm = 'title: 테스트 초안\nslug: test-draft') {
  const p = join(DIR, `${name}.md`);
  writeFileSync(p, `---\n${fm}\n---\n${body}`, 'utf8');
  return p;
}

/** 한글 음절 n개짜리 본문 — 길이 게이트 경계를 만들기 위한 것. */
const syllables = (n) => '가'.repeat(n);

describe('check-length — 음절 경계', () => {
  test('하한 미만이면 차단한다', async () => {
    const r = await length(draft('short', syllables(1499)));
    assert.equal(r.pass, false);
    assert.equal(r.evidence.syllable_count, 1499);
  });

  test('하한 정확히면 통과한다 (경계 포함)', async () => {
    const r = await length(draft('min', syllables(1500)));
    assert.equal(r.pass, true);
  });

  test('상한 정확히면 통과한다 (경계 포함)', async () => {
    const r = await length(draft('max', syllables(2000)));
    assert.equal(r.pass, true);
  });

  test('상한 초과면 차단한다', async () => {
    const r = await length(draft('long', syllables(2001)));
    assert.equal(r.pass, false);
  });

  test('코드블록·HTML 은 세지 않는다', async () => {
    const body = syllables(1500) + '\n\n```js\n' + 'x'.repeat(50) + '\n```\n<b>태그</b>';
    const r = await length(draft('stripped', body));
    // '태그' 2음절은 태그를 벗긴 뒤 남으므로 1502
    assert.equal(r.evidence.syllable_count, 1502);
  });

  // ⚠ `evaluate` 는 동기다. `assert.rejects` 는 **동기 throw 를 통과로 치지 않으므로**
  //    여기서는 `assert.throws` 를 써야 한다(2026-08-21 에 실제로 헷갈렸다).
  test('없는 파일은 GateError — 판정 실패(1)가 아니라 실행오류(2)다', () => {
    assert.throws(() => length(join(DIR, '없는파일.md')), (e) => {
      assert.ok(e instanceof GateError, `GateError 가 아니라 ${e.name}`);
      assert.match(e.message, /파일 읽기 실패/);
      return true;
    });
  });
});

describe('check-empty — 빈 섹션', () => {
  test('내용 있는 섹션만 있으면 통과', async () => {
    const body = '## 첫 섹션\n\n' + syllables(200) + '\n\n## 둘째 섹션\n\n' + syllables(200);
    const r = await empty(draft('filled', body));
    assert.equal(r.pass, true);
    assert.deepEqual(r.evidence.empty_sections, []);
  });

  test('본문 없는 섹션을 잡아낸다', async () => {
    const body = '## 채워진 섹션\n\n' + syllables(200) + '\n\n## 빈 섹션\n\n## 다음\n\n' + syllables(200);
    const r = await empty(draft('hollow', body));
    assert.equal(r.pass, false);
    assert.ok(r.evidence.empty_sections.length >= 1);
  });
});

describe('check-banned — 금지어', () => {
  test('금지어가 없으면 통과하고 hits 는 비어 있다', async () => {
    const r = await banned(draft('clean', syllables(300)));
    assert.equal(r.pass, true);
    assert.deepEqual(r.evidence.hits, []);
  });
});

describe('check-render-fit — 홈 형태 적합성', () => {
  test('h2 2개 미만이면 차단한다', async () => {
    const body = '## 하나뿐인 섹션\n\n' + '문단이다.\n\n'.repeat(5);
    const r = await renderFit(draft('one-h2', body));
    assert.equal(r.pass, false);
    assert.equal(r.evidence.h2_count, 1);
  });

  /**
   * 마크다운 안의 `<script>` 는 **차단 대상이 아니다** — `mdToHtml` 이
   * `&lt;script&gt;` 로 이스케이프하므로 렌더 결과에 실행 가능한 태그가 없다.
   * 게이트가 막아야 하는 것은 그 다음 단계, **이미 HTML 인 입력**이다.
   * (이 구분을 모르면 "게이트가 XSS 를 통과시켰다" 는 오독을 하게 된다.)
   */
  test('마크다운의 script 는 이스케이프되므로 통과가 옳다', async () => {
    const body = '## 가\n\n문단.\n\n## 나\n\n문단.\n\n문단.\n\n<script>alert(1)</script>';
    const r = await renderFit(draft('md-script', body));
    assert.equal(r.evidence.has_script, false, '이스케이프됐는데 script 로 잡혔다');
    assert.equal(r.pass, true, r.reason);
  });

  test('HTML 입력의 script 는 차단한다 (진짜 XSS 경로)', async () => {
    const p = join(DIR, 'raw.html');
    writeFileSync(p, '<h2>가</h2><p>문단</p><h2>나</h2><p>문단</p><p>문단</p><script>alert(1)</script>', 'utf8');
    const r = await renderFit(p);
    assert.equal(r.evidence.has_script, true, 'HTML 입력의 script 를 못 잡았다');
    assert.equal(r.pass, false);
  });

  test('정상 마크다운은 통과한다', async () => {
    const body = ['## 첫 섹션', '', '첫 문단이다.', '', '둘째 문단이다.', '',
                  '## 둘째 섹션', '', '셋째 문단이다.', '', '넷째 문단이다.'].join('\n');
    const r = await renderFit(draft('ok-render', body));
    assert.equal(r.pass, true, r.reason);
    assert.ok(r.evidence.h2_count >= 2 && r.evidence.p_count >= 3);
  });
});

describe('check-internal-dup — 섹션 간 재진술', () => {
  test('같은 문단을 두 섹션에 복사하면 차단한다', async () => {
    const para = '자동화 파이프라인은 수집과 검증과 발행의 세 단계로 이루어진다. 각 단계는 결정론 게이트가 판정한다. 실패하면 재시도하거나 폐기한다.';
    const body = `## 개요\n\n${para}\n\n## 정리\n\n${para}`;
    const r = await internalDup(draft('dup-section', body));
    assert.equal(r.pass, false, r.reason);
    assert.ok(r.evidence.max_pair_jaccard > r.evidence.threshold);
  });

  test('서로 다른 내용이면 통과한다', async () => {
    const body = ['## 수집', '', '레딧과 해커뉴스에서 주제 후보를 모은다. RSS 와 공개 API 만 쓴다.', '',
                  '## 발행', '', '게이트를 통과한 초안만 사이트에 올라간다. 실패하면 다음 날로 미룬다.'].join('\n');
    const r = await internalDup(draft('distinct', body));
    assert.equal(r.pass, true, r.reason);
  });
});
