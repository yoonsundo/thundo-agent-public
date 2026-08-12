#!/usr/bin/env node
/**
 * cardnews-review-queue.test.mjs — TIER-2 리뷰 큐 자동만료 + 월간요약 (§review, 2026-07-31 결정)
 *
 * 배경: `gate-generalization.mjs` 의 TIER-2 는 차단하지 않고 `review-queue.jsonl` 에 경고를
 * 쌓는다. 원래 설계(§3.19)는 미검토 적체가 `stale_review_days` 를 넘으면 채널을 자동 정지시키는
 * 것이었는데, 이 채널은 "사람 검수 없음"이 전제라 정지를 막을 사람이 없다 — 첫 경고로부터 14일
 * 뒤 정지가 예정된 동작이었다. 사용자는 `auto_pause_on_stale=false` 로 정지를 끄고, 대신
 * 자동만료(`expireStaleReviews`) + 월간요약(`monthlyDigest`) 으로 대체했다.
 *
 * 증명하는 것:
 *  ① 임계일(`auto_expire_days`) 안쪽 미검토 항목은 그대로 `reviewed_at:null` 로 남는다
 *  ② 임계일 지난 미검토 항목은 `reviewed_at`+`auto_reviewed` 마커로 검토완료 처리된다
 *  ③ 이미 검토된 행(사람이 남긴 `reviewed_at`)은 손대지 않는다
 *  ④ 손상된 줄이 섞여도 런은 죽지 않는다(세고 건너뛴다 — throw 하지 않는다)
 *  ⑤ `monthlyDigest` 가 자동만료/사람검토/미검토를 따로 세고, 규칙별 분해와 표본을 낸다
 *  ⑥ 🔴 `auto_pause_on_stale:false` 면, 큐가 미검토 적체로 가득 차 있어도 정지 신호가 없다
 *     — 이번 정책 변경이 실제로 인코딩하는 결정. `true` 로 켜면 신호가 켜지는 것도 함께 확인해
 *     "하드코딩된 false" 가 아니라 config 가 실제로 이 값을 몬다는 것을 증명한다
 *  ⑦ CLI `--expire`/`--digest` 가 정확히 1줄 JSON + exit 0 을 낸다
 *
 * STATE_DIR_OVERRIDE + CARDNEWS_CONFIG_OVERRIDE 로 완전 격리. 네트워크 없음.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-review-'));
process.env.STATE_DIR_OVERRIDE = TMP;      // 실 state/ 격리 — import 전에 세팅
process.env.RUN_MODE = 'mock';

const CFG_PATH = join(TMP, 'cardnews.json');
function writeCfg(reviewOverrides = {}) {
  writeFileSync(CFG_PATH, JSON.stringify({
    schema: 'cardnews/v1', channel: {}, cards: { count: 7 }, meta: {},
    publish: { enabled: false },
    review: {
      tier2_alert: true, stale_review_days: 14, auto_pause_on_stale: false,
      auto_pause_unconfirmed_liveness: 3, auto_expire_days: 14, monthly_digest: true,
      ...reviewOverrides,
    },
  }, null, 2), 'utf8');
}
writeCfg();
process.env.CARDNEWS_CONFIG_OVERRIDE = CFG_PATH;

const lib = await import('../cardnews/lib.mjs');
const gg = await import('../cardnews/gate-generalization.mjs');

mkdirSync(lib.stateRoot(), { recursive: true });

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const NOW = new Date('2026-07-31T09:00:00.000Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 3600 * 1000).toISOString();

const QPATH = lib.reviewQueuePath();
const resetQueue = () => writeFileSync(QPATH, '', 'utf8');
const appendRow = (r) => appendFileSync(QPATH, JSON.stringify(r) + '\n', 'utf8');
const appendRaw = (line) => appendFileSync(QPATH, line + '\n', 'utf8');
const readRows = () => readFileSync(QPATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const row = (over = {}) => ({
  at: daysAgo(1),
  post_id: 'cn-2026-07-30-testpost1',
  gate: 'generalization',
  count: 1,
  warnings: [{ field: 'cards[1].body', rule: 'W1', label: '국민호칭 단독 일반화', match: '독일인은 시간 엄수' }],
  reviewed_at: null,
  ...over,
});

// ═══ ① ② ③ ④ expireStaleReviews ═════════════════════════════════════════════
section('① 임계일 안쪽 — reviewed_at:null 유지');
{
  resetQueue();
  appendRow(row({ post_id: 'cn-fresh', at: daysAgo(3) }));            // 14일 안쪽 — 살아남는다
  appendRaw('{not valid json,,,');                                     // 손상 줄
  appendRow(row({ post_id: 'cn-old', at: daysAgo(40) }));               // 14일 초과 — 만료 대상
  appendRow(row({ post_id: 'cn-human', at: daysAgo(35), reviewed_at: daysAgo(20) })); // 이미 사람이 검토

  let r;
  ok('🔴 손상 줄이 섞여도 throw 하지 않는다', (() => {
    try { r = gg.expireStaleReviews({ cfg: lib.loadConfig(), now: NOW }); return true; }
    catch (e) { console.log(`    예외: ${e.message}`); return false; }
  })());

  eq('④ 손상 줄 1건 카운트(skipped)', r.skipped, 1);
  eq('② 만료 1건(cn-old)', r.expired, 1);
  eq('① 잔여(미검토) 1건(cn-fresh)', r.remaining, 1);

  const rows = readRows();
  eq('손상 줄은 재기록에서 빠진다(유효 3줄만 남음)', rows.length, 3);

  const fresh = rows.find(x => x.post_id === 'cn-fresh');
  ok('① cn-fresh 는 여전히 reviewed_at:null', fresh && fresh.reviewed_at === null, JSON.stringify(fresh));

  const old = rows.find(x => x.post_id === 'cn-old');
  ok('② cn-old 는 auto_reviewed 마커로 검토완료', old && old.auto_reviewed === gg.AUTO_REVIEWED_MARK, JSON.stringify(old));
  eq('② cn-old 의 reviewed_at 은 now', old?.reviewed_at, NOW.toISOString());
  eq('② cn-old 의 다른 필드(count) 보존', old?.count, 1);
  eq('② cn-old 의 warnings 보존', old?.warnings?.[0]?.rule, 'W1');

  const human = rows.find(x => x.post_id === 'cn-human');
  ok('③ 이미 검토된 행은 손대지 않는다(reviewed_at 그대로)', human && human.reviewed_at === daysAgo(20), JSON.stringify(human));
  ok('③ 사람 검토 행에는 auto_reviewed 가 없다', human && human.auto_reviewed === undefined);
}

section('② 재실행 — 이미 만료된 행은 또 건드리지 않는다(멱등)');
{
  const r2 = gg.expireStaleReviews({ cfg: lib.loadConfig(), now: new Date(NOW.getTime() + 3600000) });
  eq('두 번째 런은 만료할 게 없다', r2.expired, 0);
  eq('잔여는 그대로 1건', r2.remaining, 1);
}

section('빈 큐 — 크래시 없이 0/0');
{
  resetQueue();
  const r3 = gg.expireStaleReviews({ cfg: lib.loadConfig(), now: NOW });
  eq('expired 0', r3.expired, 0);
  eq('remaining 0', r3.remaining, 0);
  eq('skipped 0', r3.skipped, 0);
}

// ═══ ⑤ monthlyDigest ═════════════════════════════════════════════════════════
section('⑤ monthlyDigest — 자동만료/사람검토/미검토 분리 집계');
{
  resetQueue();
  // A: 자동만료 (7월)
  appendRow(row({
    post_id: 'cn-2026-07-05-digesta', at: '2026-07-05T00:00:00.000Z',
    reviewed_at: '2026-07-20T00:00:00.000Z', auto_reviewed: gg.AUTO_REVIEWED_MARK,
    warnings: [{ field: 'cards[1].body', rule: 'W1', label: '국민호칭 단독 일반화', match: '문장A-무검토로나감' }],
  }));
  // B: 사람검토 (7월)
  appendRow(row({
    post_id: 'cn-2026-07-03-digestb', at: '2026-07-03T00:00:00.000Z',
    reviewed_at: '2026-07-10T00:00:00.000Z',
    warnings: [{ field: 'outro.body', rule: 'W2', label: '지시대명사 일반화', match: '문장B' }],
  }));
  // C: 미검토, 경고 2건 (7월)
  appendRow(row({
    post_id: 'cn-2026-07-25-digestc', at: '2026-07-25T00:00:00.000Z', reviewed_at: null,
    warnings: [
      { field: 'cover.sub', rule: 'W1', label: '국민호칭 단독 일반화', match: '문장C1' },
      { field: 'cards[2].body', rule: 'W3', label: '장거리 본질화', match: '문장C2' },
    ],
  }));
  // D: 다른 달(6월) — 7월 요약에서 제외돼야 한다
  appendRow(row({
    post_id: 'cn-2026-06-15-digestd', at: '2026-06-15T00:00:00.000Z', reviewed_at: null,
    warnings: [{ field: 'cover.sub', rule: 'W1', label: '국민호칭 단독 일반화', match: '문장D-6월' }],
  }));

  const digest = gg.monthlyDigest({ cfg: lib.loadConfig(), now: NOW, month: '2026-07' });

  eq('month 반영', digest.month, '2026-07');
  eq('대상 글 3건(D 는 6월이라 제외)', digest.total_posts, 3);
  eq('총 히트 4건(A:1 + B:1 + C:2)', digest.total_hits, 4);
  eq('자동만료 1건(A)', digest.auto_expired, 1);
  eq('사람검토 1건(B)', digest.human_reviewed, 1);
  eq('미검토 1건(C)', digest.pending, 1);

  const w1 = digest.by_rule.find(r => r.rule === 'W1');
  const w2 = digest.by_rule.find(r => r.rule === 'W2');
  const w3 = digest.by_rule.find(r => r.rule === 'W3');
  eq('규칙별 W1 = 2건(A + C의 W1)', w1?.count, 2);
  eq('규칙별 W2 = 1건(B)', w2?.count, 1);
  eq('규칙별 W3 = 1건(C)', w3?.count, 1);

  eq('표본은 자동만료(A)에서만 나온다', digest.samples.length, 1);
  eq('표본 문장', digest.samples[0]?.match, '문장A-무검토로나감');
  eq('표본 post_id', digest.samples[0]?.post_id, 'cn-2026-07-05-digesta');

  const text = gg.formatDigestText(digest);
  ok('평문 포매터가 문자열을 낸다', typeof text === 'string' && text.includes('2026-07'));
  ok('평문에 자동만료 문구 포함', text.includes('자동만료'));

  // sampleLimit 이 실제로 상한을 건다 — A 하나뿐이라 별 차이 없으니 0 으로 강제해 확인.
  const digestNoSample = gg.monthlyDigest({ cfg: lib.loadConfig(), now: NOW, month: '2026-07', sampleLimit: 0 });
  eq('sampleLimit:0 → 표본 0건', digestNoSample.samples.length, 0);
}

// ═══ ⑥ 🔴 auto_pause_on_stale — 정지 신호 ═══════════════════════════════════
section('⑥ 🔴 auto_pause_on_stale:false — 적체가 있어도 정지 신호 없음(이번 정책의 핵심)');
{
  resetQueue();
  // stale_review_days(14) 를 훌쩍 넘긴 미검토 행 5개 — 원래 설계면 채널이 멈췄어야 할 상황.
  for (let i = 0; i < 5; i++) {
    appendRow(row({ post_id: `cn-2026-06-01-stale${i}`, at: daysAgo(60 - i), reviewed_at: null }));
  }

  const cfgOff = lib.loadConfig();   // auto_pause_on_stale:false (기본 픽스처)
  eq('픽스처 확인 — auto_pause_on_stale=false', cfgOff.review.auto_pause_on_stale, false);

  const signalOff = gg.checkAutoPauseSignal({ cfg: cfgOff, now: NOW });
  eq('stale_count 는 정직하게 5(적체는 실재한다)', signalOff.stale_count, 5);
  eq('🔴 enabled:false', signalOff.enabled, false);
  eq('🔴 would_pause:false — 큐가 가득 차도 정지 신호가 없다', signalOff.would_pause, false);

  const digestOff = gg.monthlyDigest({ cfg: cfgOff, now: NOW, month: '2026-06' });
  eq('digest.pause_signal 도 동일하게 would_pause:false', digestOff.pause_signal.would_pause, false);
  eq('digest.pause_signal.stale_count 도 5', digestOff.pause_signal.stale_count, 5);

  // 대조군 — config 가 정말로 이 값을 모는지 확인(하드코딩된 false 가 아님을 증명).
  writeCfg({ auto_pause_on_stale: true });
  const cfgOn = lib.loadConfig();
  const signalOn = gg.checkAutoPauseSignal({ cfg: cfgOn, now: NOW });
  eq('대조군 — auto_pause_on_stale:true 면 enabled:true', signalOn.enabled, true);
  eq('대조군 — 같은 적체로 would_pause:true', signalOn.would_pause, true);
  writeCfg();   // 원복(false) — 이후 섹션에 영향 주지 않는다
}

// ═══ ⑦ CLI — --expire / --digest ════════════════════════════════════════════
section('⑦ CLI — --expire · --digest (정확히 1줄 JSON, exit 0)');
{
  const GATE = new URL('../cardnews/gate-generalization.mjs', import.meta.url).pathname;
  const runCli = (args) => {
    const r = spawnSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, STATE_DIR_OVERRIDE: TMP, CARDNEWS_CONFIG_OVERRIDE: CFG_PATH, RUN_MODE: 'mock' },
    });
    const outLines = String(r.stdout).trim().split('\n').filter(Boolean);
    let out = null;
    try { out = JSON.parse(outLines[outLines.length - 1]); } catch { /* 아래서 드러난다 */ }
    return { code: r.status, out, lineCount: outLines.length };
  };

  resetQueue();
  appendRow(row({ post_id: 'cn-2026-06-01-clistale', at: daysAgo(60), reviewed_at: null }));

  const exp = runCli(['--expire']);
  eq('--expire exit 0', exp.code, 0);
  eq('--expire stdout 정확히 1줄', exp.lineCount, 1);
  eq('--expire mode 필드', exp.out?.mode, 'expire');
  ok('--expire expired>=1', Number(exp.out?.expired) >= 1, JSON.stringify(exp.out));

  const dig = runCli(['--digest', '2026-06']);
  eq('--digest exit 0', dig.code, 0);
  eq('--digest stdout 정확히 1줄', dig.lineCount, 1);
  eq('--digest mode 필드', dig.out?.mode, 'digest');
  eq('--digest month 반영', dig.out?.month, '2026-06');

  ok('🔴 --line 모드는 여전히 동작(회귀 방지)', runCli(['--line', '일본에서는 밥그릇을 들고 먹는다']).code === 0);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ncardnews review-queue(§review 자동만료+월간요약): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
