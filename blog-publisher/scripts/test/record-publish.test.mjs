#!/usr/bin/env node
/**
 * record-publish.test.mjs — 발행 기록이 **모양을 잃지 않는다**.
 *
 * 🔴 이 기록이 LLM 손에 있었을 때 실제로 벌어진 일(2026-09 실측):
 *      09-03 `published`=배열(3) · 09-04 없음 · 09-05 **정수 3** · 09-06 배열(3) · 09-07 없음
 *    같은 필드가 날마다 다른 타입이라 이사회가 매일 "발행 0편"으로 읽었다.
 *    실제로는 매일 3편씩 정상 발행되고 있었다. **모양이 흔들리는 값은 지표가 될 수 없다.**
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
const { mergePublished, slugOf, frontmatterValue } = await import('../report/record-publish.mjs');

let passN = 0, failN = 0;
const ok = (n, c) => { if (c) { passN++; console.log(`  [PASS] ${n}`); } else { failN++; console.log(`  [FAIL] ${n}`); } };
const eq = (n, a, b) => ok(`${n}${a === b ? '' : ` — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`, a === b);

eq('날짜 접두어를 떼고 slug 를 뽑는다', slugOf('published/2026-09-07-my-post.md'), 'my-post');
eq('  └ 접두어가 없으면 파일명 그대로', slugOf('foo.md'), 'foo');
eq('frontmatter 값을 읽는다', frontmatterValue('title: "가나다"\n', 'title'), '가나다');
eq('  └ 없으면 null(빈 문자열과 구분)', frontmatterValue('x: 1\n', 'title'), null);

{
  const a = mergePublished({}, { slug: 's1' });
  eq('빈 run 에 첫 항목', a.published.length, 1);
  const b = mergePublished(a, { slug: 's2' });
  eq('  └ 두 번째 항목이 추가된다', b.published.length, 2);
  const c = mergePublished(b, { slug: 's1', title: '수정' });
  eq('같은 slug 는 중복되지 않는다(멱등)', c.published.length, 2);
  eq('  └ 다시 기록하면 값이 갱신된다', c.published.find(p => p.slug === 's1').title, '수정');
}

/**
 * ⚠ 이미 다른 모양으로 들어와 있는 값을 **버리지 않는다.** 조용히 지우면
 *    그날 무슨 일이 있었는지 사라져서, 지금 하고 있는 이 진단 자체가 불가능해진다.
 */
{
  const n = mergePublished({ published: 3 }, { slug: 's1' });
  eq('정수가 들어와 있어도 배열로 바로잡는다', Array.isArray(n.published), true);
  eq('  └ 원래 값은 옆에 보존한다', n.published_legacy, 3);
  eq('  └ 새 항목은 정상 기록된다', n.published.length, 1);

  const s = mergePublished({ published: '3편' }, { slug: 'x' });
  eq('문자열이어도 같다', s.published_legacy, '3편');

  const keep = mergePublished({ published: [{ slug: 'old' }], date: '2026-09-07' }, { slug: 'new' });
  eq('기존 배열 항목을 지우지 않는다', keep.published.length, 2);
  eq('  └ 다른 필드도 보존한다', keep.date, '2026-09-07');
  eq('  └ 정상 배열이면 legacy 를 만들지 않는다', keep.published_legacy, undefined);

  const nul = mergePublished({ published: null }, { slug: 'x' });
  eq('null 은 legacy 로 남기지 않는다(값이 없던 것)', nul.published_legacy, undefined);
}

console.log(`\n발행 기록: ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
