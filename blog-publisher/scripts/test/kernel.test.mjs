#!/usr/bin/env node
/**
 * scripts/test/kernel.test.mjs — 커널 순수함수 단위테스트
 *
 * 이 저장소 최초의 `node:test` 테스트다. 기존 52개 테스트는 전부 손수 만든
 * pass/fail 카운터 하네스였고, 그중 19개가 프로세스를 spawn 했다 — 실행 스크립트
 * 164개 중 103개에 main 가드가 없어 import 하는 것만으로 부작용이 났기 때문이다.
 * 커널은 부작용이 없으므로 처음으로 **직접 import 해서 밀리초 단위로** 검사할 수 있다.
 *
 * 실행: node --test scripts/test/kernel.test.mjs   (npm run test:kernel)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripFrontmatter, stripCode, stripHtml, stripBody, countKoreanSyllables,
} from '../kernel/markdown.mjs';
import { kstDate, kstHour, kstWeekday, kstDateShift } from '../kernel/clock.mjs';
import {
  charFourgrams, minHash, jaccardFromSigs, encodeSig, decodeSig, SIG_K,
} from '../kernel/minhash.mjs';
import { makeLifecycle } from '../kernel/lifecycle.mjs';

describe('kernel/markdown', () => {
  test('stripFrontmatter — 있으면 제거, 없으면 원문', () => {
    assert.equal(stripFrontmatter('---\ntitle: x\n---\n본문'), '본문');
    assert.equal(stripFrontmatter('본문만'), '본문만');
  });

  test('stripFrontmatter — CRLF 도 처리한다', () => {
    assert.equal(stripFrontmatter('---\r\ntitle: x\r\n---\r\n본문'), '본문');
  });

  test('stripFrontmatter — 본문 안의 --- 는 구분자로 오해하지 않는다', () => {
    const doc = '---\ntitle: x\n---\n앞\n\n---\n\n뒤';
    assert.equal(stripFrontmatter(doc), '앞\n\n---\n\n뒤');
  });

  test('stripCode — 펜스드·인라인 제거, HTML 은 남긴다', () => {
    const t = '앞\n```js\nconst a = 1;\n```\n`inline` <b>굵게</b> 뒤';
    const out = stripCode(t);
    assert.ok(!out.includes('const a'), '펜스드 코드가 남았다');
    assert.ok(!out.includes('inline'), '인라인 코드가 남았다');
    assert.ok(out.includes('<b>'), 'stripCode 는 HTML 을 건드리지 않아야 한다');
  });

  test('stripHtml — 태그만 지우고 내용은 남긴다', () => {
    assert.equal(stripHtml('<p>안녕</p>'), '안녕');
    assert.equal(stripHtml('<img src="a.png" alt="그림">'), '');
  });

  /**
   * F-09 의 핵심. 길이 게이트는 HTML 을 지우고 세고, 밀도·헤징 게이트는 남기고 셌다.
   * 삽화가 든 초안에서 두 게이트의 분모가 달라지던 실제 불일치를 여기서 고정한다.
   */
  test('stripBody — html 옵션이 길이 게이트와 밀도 게이트의 차이를 만든다', () => {
    const doc = '---\nt: x\n---\n<figure><img alt="다이어그램"></figure>\n본문이다';
    const withHtml    = stripBody(doc, { html: true });
    const withoutHtml = stripBody(doc, { html: false });
    assert.ok(!withHtml.includes('<figure>'), 'html:true 면 태그가 없어야 한다');
    assert.ok(withoutHtml.includes('<figure>'), 'html:false 면 태그가 남아야 한다');
    assert.notEqual(withHtml, withoutHtml);
  });

  test('countKoreanSyllables — 한글 음절만 센다', () => {
    assert.equal(countKoreanSyllables('가나다'), 3);
    assert.equal(countKoreanSyllables('abc 123 !@#'), 0);
    assert.equal(countKoreanSyllables('한글 abc 섞임'), 4);   // 한글(2)+섞임(2)
    assert.equal(countKoreanSyllables('ㄱㄴㄷ'), 0);          // 자모는 음절이 아니다
  });
});

describe('kernel/clock', () => {
  test('kstDate — UTC 15:00 이 KST 로 다음날 00:00', () => {
    assert.equal(kstDate('2026-08-21T14:59:59.999Z'), '2026-08-21');
    assert.equal(kstDate('2026-08-21T15:00:00.000Z'), '2026-08-22');
  });

  test('kstHour — 0~23, h23 표기', () => {
    assert.equal(kstHour('2026-08-21T15:00:00Z'), 0);
    assert.equal(kstHour('2026-08-21T14:59:59Z'), 23);
    assert.equal(kstHour('2026-08-21T03:00:00Z'), 12);
  });

  test('kstDate — Date·문자열·숫자를 모두 받는다', () => {
    const iso = '2026-08-21T03:00:00.000Z';
    const d = new Date(iso);
    assert.equal(kstDate(d), kstDate(iso));
    assert.equal(kstDate(d), kstDate(d.getTime()));
  });

  test('kstWeekday — 요일 약어', () => {
    assert.equal(kstWeekday('2026-08-21T03:00:00Z'), 'Fri');
  });

  test('kstDateShift — 자정 직후에도 하루 단위로 정확히 움직인다', () => {
    const justAfterMidnightKst = '2026-08-21T15:00:00.000Z';   // KST 08-22 00:00
    assert.equal(kstDateShift(justAfterMidnightKst, 0),  '2026-08-22');
    assert.equal(kstDateShift(justAfterMidnightKst, -1), '2026-08-21');
    assert.equal(kstDateShift(justAfterMidnightKst, 1),  '2026-08-23');
  });

  test('kstDateShift — 월·연 경계를 넘는다', () => {
    assert.equal(kstDateShift('2026-08-31T03:00:00Z', 1), '2026-09-01');
    assert.equal(kstDateShift('2026-12-31T03:00:00Z', 1), '2027-01-01');
    assert.equal(kstDateShift('2026-03-01T03:00:00Z', -1), '2026-02-28');
  });

  test('시계를 주입받으므로 "지금" 에 의존하지 않는다', () => {
    // 같은 입력이면 언제 돌려도 같은 값 — 이게 없어서 자정 경계를 테스트할 수 없었다
    assert.equal(kstDate('2026-01-01T00:00:00Z'), kstDate('2026-01-01T00:00:00Z'));
  });
});

describe('kernel/minhash', () => {
  test('charFourgrams — 4글자 창, 공백은 하나로 접는다', () => {
    assert.deepEqual([...charFourgrams('abcde')], ['abcd', 'bcde']);
    assert.deepEqual([...charFourgrams('a  b c')], [...charFourgrams('a b c')]);
  });

  test('charFourgrams — 4글자 미만이면 빈 집합', () => {
    assert.equal(charFourgrams('abc').size, 0);
  });

  test('minHash — 길이 k, 같은 입력이면 같은 서명(결정론)', () => {
    const g = charFourgrams('중복 검사용 한국어 문장이다');
    const a = minHash(g), b = minHash(g);
    assert.equal(a.length, SIG_K);
    assert.deepEqual(a, b);
  });

  test('jaccardFromSigs — 자기 자신은 1, 무관한 문서는 낮다', () => {
    const s1 = minHash(charFourgrams('완전히 동일한 한국어 본문입니다'));
    const s2 = minHash(charFourgrams('완전히 동일한 한국어 본문입니다'));
    const s3 = minHash(charFourgrams('전혀 다른 주제의 글이며 겹치는 표현이 없다'));
    assert.equal(jaccardFromSigs(s1, s2), 1);
    assert.ok(jaccardFromSigs(s1, s3) < 0.25, '무관한 문서가 임계를 넘었다');
  });

  test('encodeSig/decodeSig — base64 왕복 무손실', () => {
    const sig = minHash(charFourgrams('왕복 검사용 한국어 본문 문장'));
    assert.deepEqual(decodeSig(encodeSig(sig)), sig);
  });

  test('decodeSig — 길이가 다르면 null (다른 k 로 만든 캐시 무효화)', () => {
    assert.equal(decodeSig('YWJj'), null);
    assert.equal(decodeSig('!!!not base64!!!'), null);
  });
});

describe('kernel/lifecycle', () => {
  // 실제 채널(호기심 쇼츠)의 표를 그대로 쓴다 — 장난감 예제로는 회귀를 못 잡는다.
  const lc = makeLifecycle({
    states: ['produced', 'uploaded', 'held', 'retired'],
    transitions: {
      null:     ['produced', 'held'],
      held:     ['held', 'produced', 'retired'],
      produced: ['uploaded', 'held', 'retired'],
      uploaded: [],
      retired:  [],
    },
    terminal: ['uploaded', 'retired'],
  });

  test('시작 상태(null)에서 갈 수 있는 곳만 허용한다', () => {
    assert.equal(lc.canTransition(null, 'produced').ok, true);
    assert.equal(lc.canTransition(null, 'held').ok, true);
    assert.equal(lc.canTransition(null, 'uploaded').ok, false,
      '제작도 안 한 아이템이 업로드됨으로 갈 수 있으면 안 된다');
  });

  test('종단 상태에서는 어떤 전이도 없다', () => {
    const v = lc.canTransition('uploaded', 'produced');
    assert.equal(v.ok, false);
    assert.match(v.reason, /종단 상태/);
    assert.equal(lc.isTerminal('uploaded'), true);
    assert.equal(lc.isTerminal('held'), false);
  });

  test('모르는 상태는 조용히 통과시키지 않는다', () => {
    assert.equal(lc.canTransition('produced', '완전히새로운상태').ok, false);
    assert.equal(lc.canTransition('알수없음', 'produced').ok, false);
  });

  test('자기 전이는 표에 있을 때만 허용한다', () => {
    assert.equal(lc.canTransition('held', 'held').ok, true, 'held 재시도는 정상 흐름이다');
    assert.equal(lc.canTransition('produced', 'produced').ok, false);
    assert.match(lc.canTransition('produced', 'produced').reason, /flush\(\)/);
  });

  test('불허 사유에 허용 목록이 들어간다 (로그만 보고 추적 가능해야 한다)', () => {
    const v = lc.canTransition('held', 'uploaded');
    assert.equal(v.ok, false);
    assert.match(v.reason, /허용: held, produced, retired/);
  });

  test('상태 집합·간선은 얼려서 돌려준다', () => {
    assert.throws(() => { lc.states.push('x'); });
    assert.equal(Object.isFrozen(lc.transitions), true);
  });
});
