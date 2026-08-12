#!/usr/bin/env node
/**
 * cardnews-insights.test.mjs — 인사이트 수집(읽기 전용) 유닛테스트
 *
 * 증명 대상:
 *  ① **happy path** — 발행된 글마다 정확히 한 줄, 다섯 메트릭이 그대로 실린다.
 *  ② **너무 최근인 글** — 인사이트가 아직 없다고 거부돼도 `{error_class}` 한 줄로 남고,
 *     같은 런의 다른 글 수집은 계속된다(한 건이 그날 수집 전체를 죽이지 않는다).
 *  ③ **만료 토큰 fail-closed** — (a) 토큰 파일이 없으면 네트워크를 **한 번도** 부르지 않고
 *     파일도 안 만든다. (b) 도중에 만료가 뜨면 남은 글을 더 두드리지 않고 중단한다.
 *     둘 다 throw 하지 않는다.
 *  ④ **append, upsert 아님** — 같은 글을 두 번 수집하면 **두 줄**. 저장이 늦게 붙는지는
 *     곡선으로만 보이므로, 여기서 upsert 로 회귀하면 지표 자체가 무의미해진다.
 *  ⑤ **published_media_id 없는 글은 건너뛴다** — 줄이 생기지 않는다.
 *  ⑥ 메트릭 이름 거부(code 100) → core 세트로 **한 번만** 축소 재시도(부분 응답이 없는 API 대응).
 *  ⑦ `report --insights` 판정 — save_rate 가중총계·top/bottom·days_covered.
 *
 * 네트워크·크리덴셜 없음(`fetchImpl` 전량 스텁). 실 state/ 오염 금지 — paths 는 config.mjs
 * import 시점에 확정되므로 STATE_DIR_OVERRIDE 를 먼저 세팅하고 동적 import 한다.
 * exit 0 = 전체 통과 / 1 = 실패.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-insights-'));
process.env.STATE_DIR_OVERRIDE = TMP;   // 실 state/ 격리 — 반드시 import 전
process.env.RUN_MODE = 'mock';

const ins = await import(new URL('../cardnews/insights.mjs', import.meta.url).href);
const rep = await import(new URL('../cardnews/report.mjs', import.meta.url).href);

// ─── 하네스 ───────────────────────────────────────────────────────────────────

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const resp = (status, body) => ({ status, json: async () => body, text: async () => JSON.stringify(body ?? {}) });

const insightsBody = (m) => ({
  data: Object.entries(m).map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }] })),
});

const TOKEN = {
  ig_user_id: '17841400000000000',
  access_token: 'stub-token',
  issued_at: '2026-07-01T00:00:00.000Z',
  expires_at: '2026-08-30T00:00:00.000Z',
  graph_base: 'https://graph.instagram.test',
  api_version: 'v25.0',
};
const CFG = { insights: { enabled: true }, meta: { token_file: join(TMP, 'no-such-token.json') } };
const NOW = new Date('2026-08-10T02:00:00.000Z');

const post = (id, mediaId, publishedAt) => ({
  post_id: id, published_media_id: mediaId, published_at: publishedAt, status: 'published',
});

function resetJsonl() { rmSync(ins.insightsPath(), { force: true }); }
function rows() {
  if (!existsSync(ins.insightsPath())) return [];
  return readFileSync(ins.insightsPath(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// ─── 1. happy path ────────────────────────────────────────────────────────────
console.log('\n[1] happy path — 발행 글마다 한 줄, 다섯 메트릭');
{
  resetJsonl();
  const index = {
    'cn-2026-08-01-aaaa1111': post('cn-2026-08-01-aaaa1111', '1001', '2026-08-01T02:00:00.000Z'),
    'cn-2026-08-05-bbbb2222': post('cn-2026-08-05-bbbb2222', '1002', '2026-08-05T02:00:00.000Z'),
  };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return resp(200, insightsBody({
      saved: url.includes('1001') ? 40 : 12, shares: 3, reach: url.includes('1001') ? 800 : 600,
      profile_visits: 5, total_interactions: 70,
    }));
  };

  const r = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl, token: TOKEN, index });
  eq('ok', r.ok, true);
  eq('collected=2', r.collected, 2);
  eq('failed=0', r.failed, 0);

  const rs = rows();
  eq('jsonl 2줄', rs.length, 2);
  const a = rs.find(x => x.published_media_id === '1001');
  eq('saved 실림', a.saved, 40);
  eq('reach 실림', a.reach, 800);
  eq('shares 실림', a.shares, 3);
  eq('profile_visits 실림', a.profile_visits, 5);
  eq('total_interactions 실림', a.total_interactions, 70);
  eq('age_days 계산(8/1→8/10)', a.age_days, 9);
  eq('collected_at 기록', a.collected_at, NOW.toISOString());
  ok('요청 URL 이 다섯 메트릭 전부 포함', seen[0].includes('saved') && seen[0].includes('profile_visits'), seen[0]);
  ok('insights 엔드포인트', seen[0].includes('/insights?metric='), seen[0]);
}

// ─── 2. 너무 최근인 글 — 한 건 실패가 런을 죽이지 않는다 ──────────────────────
console.log('\n[2] 인사이트 미가용(너무 최근) — error_class 로 남고 계속 진행');
{
  resetJsonl();
  const index = {
    'cn-a': post('cn-a', '2001', '2026-08-10T01:00:00.000Z'),   // 1시간 전 발행
    'cn-b': post('cn-b', '2002', '2026-08-01T02:00:00.000Z'),
  };
  const fetchImpl = async (url) => url.includes('2001')
    ? resp(400, { error: { message: 'Insights are not available for this media', code: 100, type: 'OAuthException' } })
    : resp(200, insightsBody({ saved: 9, shares: 1, reach: 300, profile_visits: 2, total_interactions: 20 }));

  const r = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl, token: TOKEN, index });
  eq('throw 없이 ok', r.ok, true);
  eq('collected=1', r.collected, 1);
  eq('failed=1', r.failed, 1);

  const rs = rows();
  eq('실패도 한 줄 남는다', rs.length, 2);
  const bad = rs.find(x => x.published_media_id === '2001');
  eq('error_class=insights-unavailable', bad.error_class, 'insights-unavailable');
  ok('실패 줄엔 메트릭이 없다', bad.saved === undefined, JSON.stringify(bad));
  ok('뒤 글은 정상 수집', rs.find(x => x.published_media_id === '2002').saved === 9);
}

// ─── 3. 토큰 fail-closed ──────────────────────────────────────────────────────
console.log('\n[3] 토큰 fail-closed — 네트워크 이전 차단 + 도중 만료 시 중단');
{
  resetJsonl();
  const index = { 'cn-a': post('cn-a', '3001', '2026-08-01T02:00:00.000Z') };
  let calls = 0;
  const fetchImpl = async () => { calls++; return resp(200, insightsBody({ saved: 1 })); };

  // (a) 토큰 파일 없음 → 네트워크 0회, 파일 미생성, throw 없음
  const r = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl, index });
  eq('ok:false', r.ok, false);
  ok('사유가 토큰을 지목', /토큰 fail-closed/.test(r.reason || ''), r.reason);
  eq('네트워크 0회', calls, 0);
  eq('jsonl 미생성', existsSync(ins.insightsPath()), false);

  // (b) 도중 만료(code 190) → 남은 글 두드리지 않음
  resetJsonl();
  const many = {
    'cn-1': post('cn-1', '3101', '2026-08-01T02:00:00.000Z'),
    'cn-2': post('cn-2', '3102', '2026-08-02T02:00:00.000Z'),
    'cn-3': post('cn-3', '3103', '2026-08-03T02:00:00.000Z'),
  };
  let n = 0;
  const expired = async () => { n++; return resp(400, { error: { message: 'Session expired', code: 190, type: 'OAuthException' } }); };
  const r2 = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl: expired, token: TOKEN, index: many });
  eq('ok:false(중단)', r2.ok, false);
  eq('aborted', r2.aborted, true);
  eq('첫 건에서 멈춤 — 네트워크 1회', n, 1);
  eq('실패 줄 1개만', rows().length, 1);
  eq('error_class=token-expired', rows()[0].error_class, 'token-expired');

  // fetchInsights 단독으로도 throw 하지 않는다
  const one = await ins.fetchInsights('9999', { access_token: 'x' }, { fetchImpl: expired });
  eq('fetchInsights 만료 → ok:false', one.ok, false);
  eq('fetchInsights 만료 라벨', one.error_class, 'token-expired');
}

// ─── 4. append, upsert 아님 ───────────────────────────────────────────────────
console.log('\n[4] append-only — 같은 글 2회 수집 = 2줄(성장곡선)');
{
  resetJsonl();
  const index = { 'cn-a': post('cn-a', '4001', '2026-08-01T02:00:00.000Z') };
  const day1 = async () => resp(200, insightsBody({ saved: 5, shares: 0, reach: 200, profile_visits: 1, total_interactions: 10 }));
  const day7 = async () => resp(200, insightsBody({ saved: 31, shares: 4, reach: 900, profile_visits: 8, total_interactions: 60 }));

  await ins.collectAll({ cfg: CFG, now: new Date('2026-08-02T02:00:00.000Z'), fetchImpl: day1, token: TOKEN, index });
  await ins.collectAll({ cfg: CFG, now: new Date('2026-08-08T02:00:00.000Z'), fetchImpl: day7, token: TOKEN, index });

  const rs = rows();
  eq('두 줄(덮어쓰기 아님)', rs.length, 2);
  eq('같은 post_id', rs[0].post_id === rs[1].post_id, true);
  eq('1일차 saved 보존', rs[0].saved, 5);
  eq('7일차 saved', rs[1].saved, 31);
  ok('age_days 가 자란다', rs[1].age_days > rs[0].age_days, `${rs[0].age_days}→${rs[1].age_days}`);
}

// ─── 5. published_media_id 없는 글은 건너뛴다 ─────────────────────────────────
console.log('\n[5] 미발행 글 skip');
{
  resetJsonl();
  const index = {
    'cn-live': post('cn-live', '5001', '2026-08-01T02:00:00.000Z'),
    'cn-held': { post_id: 'cn-held', published_media_id: null, published_at: null, status: 'held' },
    'cn-draft': { post_id: 'cn-draft', status: 'scripted' },   // 키 자체가 없는 경우
  };
  let calls = 0;
  const fetchImpl = async () => { calls++; return resp(200, insightsBody({ saved: 2, reach: 100 })); };

  const r = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl, token: TOKEN, index });
  eq('skipped=2', r.skipped, 2);
  eq('collected=1', r.collected, 1);
  eq('네트워크 1회', calls, 1);
  eq('줄은 1개', rows().length, 1);
  eq('그 줄은 발행 글', rows()[0].post_id, 'cn-live');
}

// ─── 6. 메트릭 이름 거부 → core 축소 재시도 1회 ───────────────────────────────
console.log('\n[6] 메트릭 이름 거부(code 100) → core 폴백 1회');
{
  resetJsonl();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('profile_visits')) {
      return resp(400, { error: { message: '(#100) profile_visits is not a valid metric for this media product type', code: 100 } });
    }
    return resp(200, insightsBody({ saved: 7, shares: 1, reach: 250, total_interactions: 30 }));
  };

  const r = await ins.fetchInsights('6001', TOKEN, { fetchImpl });
  eq('폴백 후 성공', r.ok, true);
  eq('degraded 표시', r.degraded, true);
  eq('빠진 메트릭 명시', JSON.stringify(r.dropped), JSON.stringify(['profile_visits']));
  eq('시도 2회(재시도 1회뿐)', seen.length, 2);
  ok('2차 요청엔 profile_visits 없음', !seen[1].includes('profile_visits'), seen[1]);
  eq('saved 는 살아남는다', r.metrics.saved, 7);

  // 수집 경로에서도 degraded 가 기록된다
  const index = { 'cn-a': post('cn-a', '6001', '2026-08-01T02:00:00.000Z') };
  const c = await ins.collectAll({ cfg: CFG, now: NOW, fetchImpl, token: TOKEN, index });
  eq('collected=1', c.collected, 1);
  eq('profile_visits 는 null', rows()[0].profile_visits, null);
  eq('degraded_metrics 기록', JSON.stringify(rows()[0].degraded_metrics), JSON.stringify(['profile_visits']));

  // 권한 거부는 폴백 대상이 아니다 — 재시도하지 않는다
  seen.length = 0;
  const perm = await ins.fetchInsights('6002', TOKEN, {
    fetchImpl: async (u) => { seen.push(u); return resp(400, { error: { message: 'no permission', code: 10 } }); },
  });
  eq('권한 오류 라벨', perm.error_class, 'permission');
  eq('재시도 없음', seen.length, 1);
}

// ─── 7. report --insights 판정 ────────────────────────────────────────────────
console.log('\n[7] insightsVerdict — save_rate 가중총계 · top/bottom · days_covered');
{
  const recs = [
    { collected_at: '2026-08-02T02:00:00.000Z', post_id: 'p1', saved: 5, reach: 100, age_days: 1 },
    { collected_at: '2026-08-08T02:00:00.000Z', post_id: 'p1', saved: 40, reach: 400, age_days: 7 },  // 최신만 채택
    { collected_at: '2026-08-08T02:00:00.000Z', post_id: 'p2', saved: 10, reach: 200, age_days: 3 },
    { collected_at: '2026-08-08T02:00:00.000Z', post_id: 'p3', error_class: 'insights-unavailable' }, // 통계 제외
  ];
  const v = rep.insightsVerdict(recs);
  eq('posts=2(성공 글만)', v.posts, 2);
  eq('median_saved', v.median_saved, 25);          // (10+40)/2
  eq('median_reach', v.median_reach, 300);         // (200+400)/2
  eq('save_rate 가중총계 50/600', v.save_rate, 0.0833);
  eq('top=p1', v.top_post.post_id, 'p1');
  eq('top save_rate', v.top_post.save_rate, 0.1);
  eq('bottom=p2', v.bottom_post.post_id, 'p2');
  eq('days_covered=2(KST)', v.days_covered, 2);
  ok('p1 은 최신 줄만 반영', v.top_post.saved === 40, JSON.stringify(v.top_post));

  const empty = rep.insightsVerdict([]);
  eq('빈 입력도 throw 없음 — posts=0', empty.posts, 0);
  eq('빈 입력 save_rate=null', empty.save_rate, null);
}

// ─── 정리 ─────────────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
console.log(`\n결과: ${passN} PASS / ${failN} FAIL`);
process.exit(failN ? 1 : 0);
