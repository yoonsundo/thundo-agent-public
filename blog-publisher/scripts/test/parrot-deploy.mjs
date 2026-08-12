/**
 * parrot-deploy.mjs 테스트 — 운영 배포상태 3단계 분류 + 4채널 배지 렌더 검증.
 * ssh·claude 없이 순수 로직만. exit 0=통과, 1=실패.
 *   node scripts/test/parrot-deploy.mjs
 */
import assert from 'node:assert/strict';
import {
  classifyDeploy, deployCounts, itemDeployStatus, deployBadge, summarizeDeploy, hexOf,
} from '../report/parrot-deploy.mjs';
import { renderSlack, renderDiscord, renderTelegram, renderArchiveMd } from '../report/parrot-render.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

// ── 1) hexOf 정규화(길이 보존) ────────────────────────────────────────────────
ok('hexOf: 대문자·백틱 제거, 길이는 보존', () => {
  assert.equal(hexOf('`ABC123DE`f0'), 'abc123def0'); // 자르지 않음(축약길이 제각각 대응)
  assert.equal(hexOf('gg12'), '12');                 // 비-hex 제거
  assert.equal(hexOf(null), '');
});

// ── 2) classifyDeploy 3단계 (키는 full sha) ──────────────────────────────────
// 시나리오: develop 커밋 4개. c1,c2=운영반영(prod), c3=배포대기(main), c4=dev전용.
const F = { // 실전과 같은 40-hex full sha
  a: 'aaaa1111'.padEnd(40, '0'), b: 'bbbb2222'.padEnd(40, '0'),
  c: 'cccc3333'.padEnd(40, '0'), d: 'dddd4444'.padEnd(40, '0'),
};
const shas = [F.a, F.b, F.c, F.d];
const notInProd = new Set([F.c, F.d]); // prod HEAD 조상 아님
const notInMain = new Set([F.d]);      // main 미머지
const map = classifyDeploy(shas, notInProd, notInMain);

ok('classify: prod/main/dev 정확 분류', () => {
  assert.equal(map[F.a], 'prod');
  assert.equal(map[F.b], 'prod');
  assert.equal(map[F.c], 'main');
  assert.equal(map[F.d], 'dev');
});
ok('classify: dev전용 ⊆ 운영미반영 불변식(main 우선 판정)', () => {
  // notInMain 에 있으면 notInProd 여부와 무관하게 무조건 dev.
  const m = classifyDeploy([F.d], new Set(), new Set([F.d]));
  assert.equal(m[F.d], 'dev');
});
ok('counts 집계', () => {
  assert.deepEqual(deployCounts(map), { prod: 2, main: 1, dev: 1 });
});

// ── 3) itemDeployStatus: 가장 덜 배포된 상태(부분배포는 미완) ─────────────────
ok('item: 전부 prod → prod', () => {
  assert.equal(itemDeployStatus([F.a, F.b], map), 'prod');
});
ok('item: prod+dev 섞임 → dev(가장 덜 배포)', () => {
  assert.equal(itemDeployStatus([F.a, F.d], map), 'dev');
});
ok('item: prod+main 섞임 → main', () => {
  assert.equal(itemDeployStatus([F.a, F.c], map), 'main');
});
ok('item: map 밖 sha 뿐 → null(배지 없음)', () => {
  assert.equal(itemDeployStatus(['ffff9999'], map), null);
  assert.equal(deployBadge(null), '');
});
// ★ 회귀: LLM 이 주는 7자 축약 sha 가 full-sha 맵 키에 접두 매칭돼야 한다(dry-run 실측 버그).
ok('item: 7자 축약 sha → full 키 접두매칭(핵심 회귀)', () => {
  assert.equal(itemDeployStatus(['aaaa111'], map), 'prod');   // 7자 → F.a 매칭
  assert.equal(itemDeployStatus(['dddd444'], map), 'dev');    // 7자 → F.d 매칭
  assert.equal(itemDeployStatus(['`AAAA111`'], map), 'prod'); // 백틱+대문자 7자도
});

// ── 4) summarizeDeploy ───────────────────────────────────────────────────────
ok('summary: actual 모드 카운트 문자열', () => {
  const s = summarizeDeploy({ mode: 'actual', map, counts: deployCounts(map) });
  assert.match(s, /운영반영 2/); assert.match(s, /배포대기 1/); assert.match(s, /dev전용 1/);
});
ok('summary: proxy 모드 근사 표기', () => {
  const s = summarizeDeploy({ mode: 'proxy', map: { aaaa1111: 'prod' }, counts: { prod: 1, main: 0, dev: 0 } });
  assert.match(s, /근사/);
});
ok('summary: deploy 없으면 빈 문자열', () => {
  assert.equal(summarizeDeploy(null), '');
});

// ── 5) 4채널 렌더에 배지·요약이 실제로 박히는지 ───────────────────────────────
const brief = {
  date: '2026-07-07', project: 'observed_project',
  headline: '오늘 요약',
  authors: [{ name: '홍길동', commits: 4, summary: '작업함' }],
  items: [ // commits 는 LLM 이 주는 7자 축약 — full-sha 맵에 접두매칭돼야 배지가 뜬다
    { title: '운영 반영된 기능', tag: '기능', what: '무언가', impact: '영향', day: '07-06(월)', commits: ['aaaa111'] },
    { title: '배포 대기 기능', tag: '기능', what: '무언가2', impact: '영향2', day: '07-06(월)', commits: ['cccc333'] },
    { title: 'dev 전용 기능', tag: '수정', what: '무언가3', impact: '영향3', day: '07-06(월)', commits: ['dddd444'] },
  ],
  deploy: { mode: 'actual', map, counts: deployCounts(map) },
};

ok('Telegram: 요약+배지 렌더', () => {
  const tg = renderTelegram(brief).join('\n');
  assert.match(tg, /운영 배포현황/);
  assert.match(tg, /운영반영/); assert.match(tg, /배포대기/); assert.match(tg, /dev전용/);
});
ok('Slack: 요약 context + 항목 배지', () => {
  const sk = JSON.stringify(renderSlack(brief));
  assert.match(sk, /운영 배포현황/);
  assert.match(sk, /운영반영/); assert.match(sk, /배포대기/);
});
ok('Discord: description 요약 + field 배지', () => {
  const dc = JSON.stringify(renderDiscord(brief));
  assert.match(dc, /운영 배포현황/);
  assert.match(dc, /운영반영/); assert.match(dc, /dev전용/);
});
ok('Archive MD: 요약줄 + heading 배지', () => {
  const md = renderArchiveMd(brief);
  assert.match(md, /운영 배포현황/);
  assert.match(md, /운영반영/); assert.match(md, /배포대기/); assert.match(md, /dev전용/);
});
ok('deploy 없는 brief 는 배지 없이 정상 렌더(하위호환)', () => {
  const b2 = { ...brief, deploy: null };
  const md = renderArchiveMd(b2);
  assert.doesNotMatch(md, /운영 배포현황/);
  assert.ok(renderTelegram(b2).length > 0);
  assert.ok(renderSlack(b2).blocks.length > 0);
  assert.ok(renderDiscord(b2).embeds.length > 0);
});

console.log(`\n✅ parrot-deploy 테스트 ${pass}건 전부 통과`);
