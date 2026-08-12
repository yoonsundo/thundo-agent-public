#!/usr/bin/env node
/**
 * curiosity-analytics.test.mjs — 호기심 쇼츠 성과 폐루프(수집·경보·브리핑) 스모크 테스트
 *
 * 검증:
 *   1. mock 수집 → analytics.jsonl / channel-stats.jsonl append, exit 0
 *   2. 무음실패 제거 — 크리덴셜 부재 시 경보 페이로드 생성 + 하루1회 마커(2회째 미발송)
 *      (실 발송은 스텁 notifier 로 차단하고 반환값으로 검증)
 *   3. videos.list 코드경로 — global fetch 스텁으로 API 키 폴백 동작 + ID 50개 배치 분할
 *   4. channels.list 코드경로 — subscriberCount 파싱(구독 500 추적)
 *   5. 브리핑 본문 — 구독 500 목표 문구 + 성과 상위/하위 3편 포함
 *   6. mock 리포트 실행 → 브리핑 전문 md 생성, exit 0 (알림은 DRYRUN 으로 차단)
 *
 * 격리: STATE_DIR_OVERRIDE·CURIOSITY_ANALYTICS_REPORT_DIR 로 임시 디렉토리를 쓴다
 *       → 실제 state/·docs/ 미오염. 실 .env 크리덴셜·네트워크 없이 통과해야 한다.
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passN = 0, failN = 0;
const pass = (l) => { console.log(`  [PASS] ${l}`); passN++; };
const fail = (l, d = '') => { console.log(`  [FAIL] ${l}${d ? ' — ' + d : ''}`); failN++; };

/** 임시 state 디렉토리에 uploaded 인덱스를 깔아둔다(수집 대상이 있어야 스킵 안 됨). */
function seedIndex(stateDir, count) {
  mkdirSync(stateDir, { recursive: true });
  const idx = {};
  for (let i = 0; i < count; i++) {
    idx[`item${i}`] = {
      status: 'uploaded', at: '2026-07-20T00:00:00.000Z',
      subject: `테스트 주제 ${i}`, youtube_id: `VID${String(i).padStart(3, '0')}`,
    };
  }
  writeFileSync(join(stateDir, 'shorts-curiosity-index.json'), JSON.stringify(idx, null, 2), 'utf8');
  return idx;
}

async function runScript(rel, env) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [rel], {
      cwd: ROOT, env: { ...process.env, ...env }, timeout: 60000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ─── 1. mock 수집 ────────────────────────────────────────────────────────────
async function testMockCollect(tmp) {
  const stateDir = join(tmp, 'state-mock');
  seedIndex(stateDir, 3);
  const r = await runScript('scripts/shorts-curiosity/analytics-collect.mjs', {
    RUN_MODE: 'mock', STATE_DIR_OVERRIDE: stateDir,
  });
  const analytics = join(stateDir, 'shorts-curiosity', 'analytics.jsonl');
  const chan = join(stateDir, 'shorts-curiosity', 'channel-stats.jsonl');
  if (r.code !== 0) return fail('mock 수집 exit 0', `code=${r.code} :: ${r.stderr.slice(0, 200)}`);
  if (!existsSync(analytics)) return fail('mock 수집 analytics.jsonl append', '파일 없음');
  const recs = readFileSync(analytics, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  if (recs.length !== 3 || recs.some(x => x.views == null || !x.ts)) {
    return fail('mock 수집 레코드', JSON.stringify(recs).slice(0, 200));
  }
  pass(`mock 수집: exit 0 + analytics.jsonl ${recs.length}건 append`);

  if (existsSync(chan)) {
    const c = JSON.parse(readFileSync(chan, 'utf8').trim().split('\n').pop());
    c.subscribers != null ? pass(`mock 수집: channel-stats.jsonl 구독 ${c.subscribers}`)
      : fail('mock 채널통계 subscribers', JSON.stringify(c));
  } else fail('mock 채널통계 append', 'channel-stats.jsonl 없음');
}

// ─── 2. 경보 + 하루1회 마커 ──────────────────────────────────────────────────
async function testAlertOncePerDay(tmp) {
  const stateDir = join(tmp, 'state-alert');
  seedIndex(stateDir, 47);
  // paths 는 모듈 로드 시점에 굳으므로 env 세팅 후 동적 import.
  process.env.STATE_DIR_OVERRIDE = stateDir;
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  const mod = await import('../shorts-curiosity/analytics-collect.mjs');

  const calls = [];
  const stubNotifier = async (event, payload) => { calls.push({ event, payload }); return { telegram: 'sent', discord: 'sent' }; };

  const first = await mod.alertBlocked({
    reason: 'videos.list HTTP 403: insufficient authentication scopes',
    uploads: 47, notifier: stubNotifier,
  });
  const body = calls[0] ? `${calls[0].payload.reason}\n${calls[0].payload.details}` : '';
  const hasCause = /403|스코프|scope/i.test(body);
  const hasFix = body.includes('YOUTUBE_API_KEY') && body.includes('YouTube Data API v3');
  const hasCount = body.includes('47');
  if (first.alerted && calls.length === 1 && hasCause && hasFix && hasCount && first.sent) {
    pass('경보 1회차: 발송 + 사유/복구방법/47편 측정불가 포함 + sent 확인');
  } else {
    fail('경보 1회차', `alerted=${first.alerted} sent=${first.sent} calls=${calls.length} cause=${hasCause} fix=${hasFix} count=${hasCount}`);
  }
  if (!existsSync(first.marker)) fail('경보 마커 생성', first.marker);
  else pass(`경보 마커 생성: ${first.marker.split('/').pop()}`);

  const second = await mod.alertBlocked({
    reason: 'videos.list HTTP 403: insufficient authentication scopes',
    uploads: 47, notifier: stubNotifier,
  });
  if (!second.alerted && second.skipped === 'daily-marker' && calls.length === 1) {
    pass('경보 2회차: 같은 날 중복 발송 차단(마커)');
  } else {
    fail('경보 2회차 중복차단', `alerted=${second.alerted} skipped=${second.skipped} calls=${calls.length}`);
  }

  // 다음 날(마커 없음)에는 다시 발송돼야 한다 — 경보가 영구히 죽으면 그것도 무음실패다.
  const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000);
  const third = await mod.alertBlocked({ reason: '동일 사유', uploads: 47, notifier: stubNotifier, now: tomorrow });
  (third.alerted && calls.length === 2)
    ? pass('경보: 날짜가 바뀌면 재발송')
    : fail('경보 날짜변경 재발송', `alerted=${third.alerted} calls=${calls.length}`);

  return mod;
}

// ─── 2b. 경보 본문 — 원시 JSON 금지 + 실패 갈래별 한 줄 요약 ────────────────
/**
 * 회귀 근거(2026-07-30 실측): 경보 reason 에 YouTube API 원시 JSON 이 실려 나가
 * Telegram 이 HTTP 400 "can't parse entities" 로 거부했다 → 가장 중요한 경보가
 * 텔레그램에 도달하지 못했다(Discord 만 부분 전달). 본문은 사람이 읽는 요약이어야 한다.
 */
function testAlertBody(mod) {
  const RAW_403 = 'videos.list HTTP 403: {\n  "error": {\n    "code": 403,\n    "message": "Request had insufficient authentication scopes.",\n    "status": "PERMISSION_DENIED"\n  }\n}';

  const cases = [
    {
      label: 'OAuth 스코프 부족',
      args: { reason: RAW_403, uploads: 47, hasApiKey: true },
      kind: 'oauth-scope',
      must: ['스코프', 'youtube.upload', '47'],
    },
    {
      label: 'API 키 미설정',
      args: { reason: 'videos.list 호출 수단 없음(OAuth·API 키 모두 부재)', uploads: 47, hasApiKey: false },
      kind: 'no-api-key',
      must: ['YOUTUBE_API_KEY', 'YouTube Data API v3', '.env'],
    },
    {
      label: '그 외 HTTP 오류',
      args: { reason: 'videos.list HTTP 500: {"error":{"code":500,"message":"Internal error encountered."}}', uploads: 47, hasApiKey: true },
      kind: 'http',
      must: ['500', 'Internal error'],
    },
  ];

  for (const c of cases) {
    const p = mod.buildAlertPayload(c.args);
    const body = `${p.reason}\n${p.details}`;
    // 원시 JSON 조각이 새어나가면 실패 — Telegram Markdown 파싱을 깨뜨린 그 문자들.
    const leaks = ['{', '}', '"error"', '\\n', '"message"'].filter(x => body.includes(x));
    const missing = c.must.filter(x => !body.includes(x));
    const hasFix = /조치:/.test(body);
    if (p.kind === c.kind && leaks.length === 0 && missing.length === 0 && hasFix) {
      pass(`경보 본문 [${c.label}]: kind=${p.kind} · 원시 JSON 없음 · 요약+조치 포함`);
    } else {
      fail(`경보 본문 [${c.label}]`, `kind=${p.kind}(기대 ${c.kind}) leaks=${JSON.stringify(leaks)} missing=${JSON.stringify(missing)} fix=${hasFix}\n${body}`);
    }
  }

  // 세 갈래가 서로 다른 요약을 내야 한다(뭉뚱그린 한 문구 재사용 금지).
  const summaries = new Set(cases.map(c => mod.classifyFailure({ reason: c.args.reason, hasApiKey: c.args.hasApiKey }).summary));
  summaries.size === 3 ? pass('경보 분류: 세 갈래가 각각 다른 요약을 생성')
    : fail('경보 분류 구분', `unique=${summaries.size}`);

  // 네트워크 오류도 조치가 달라야 한다(키 발급이 답이 아님).
  const net = mod.classifyFailure({ reason: 'fetch failed ETIMEDOUT', hasApiKey: true });
  (net.kind === 'network' && /네트워크|재시도/.test(net.fix))
    ? pass('경보 분류: 네트워크 오류는 재시도 안내')
    : fail('경보 분류 네트워크', JSON.stringify(net));

  // 한 줄 요약 길이 — 경보는 스캔 가능해야 한다.
  const long = mod.buildAlertPayload({ reason: RAW_403.repeat(5), uploads: 47, hasApiKey: true });
  long.details.split('\n').every(l => l.length <= 200)
    ? pass('경보 본문: 모든 줄이 200자 이내(스캔 가능)')
    : fail('경보 본문 길이', long.details);
}

// ─── 3. videos.list API 키 폴백 + 50개 배치 ─────────────────────────────────
async function testVideosListFallback(mod) {
  const origFetch = globalThis.fetch;
  process.env.YOUTUBE_API_KEY = 'TEST_KEY';
  const urls = [];
  globalThis.fetch = async (url, opts = {}) => {
    urls.push({ url: String(url), auth: !!(opts.headers && opts.headers.Authorization) });
    // OAuth Bearer 는 업로드 전용 스코프라 403 (실측 재현) → API 키 폴백만 200.
    if (opts.headers && opts.headers.Authorization) {
      return { ok: false, status: 403, text: async () => 'insufficient authentication scopes' };
    }
    const ids = new URL(String(url)).searchParams.get('id').split(',');
    return {
      ok: true, status: 200,
      json: async () => ({
        items: ids.map((id, i) => ({
          id, snippet: { title: `제목 ${id}`, channelId: 'UC_TEST', publishedAt: '2026-07-20T00:00:00Z' },
          statistics: { viewCount: String(100 + i), likeCount: '5', commentCount: '1' },
        })),
      }),
    };
  };
  try {
    const ids47 = Array.from({ length: 47 }, (_, i) => `V${i}`);
    const map = await mod.fetchStats('fake-oauth-token', ids47);
    const keyCalls = urls.filter(u => u.url.includes('key=TEST_KEY'));
    const ok = map.size === 47 && map.get('V0').views === 100 && map.get('V0').channel_id === 'UC_TEST'
      && keyCalls.length === 1 && urls.length === 2; // Bearer 403 1회 + 키 폴백 1회
    ok ? pass('videos.list: OAuth 403 → API 키 폴백으로 47편 파싱(배치 1회)')
       : fail('videos.list API 키 폴백', `size=${map.size} urls=${urls.length} keyCalls=${keyCalls.length}`);

    // 50개 상한 배치 분할 — 120개면 50/50/20 세 번.
    urls.length = 0;
    const ids120 = Array.from({ length: 120 }, (_, i) => `W${i}`);
    const map2 = await mod.fetchStats('fake-oauth-token', ids120);
    const groupSizes = urls.filter(u => u.url.includes('key=')).map(u => new URL(u.url).searchParams.get('id').split(',').length);
    (map2.size === 120 && JSON.stringify(groupSizes) === JSON.stringify([50, 50, 20]))
      ? pass('videos.list: 50개 상한 배치 분할 [50,50,20]')
      : fail('videos.list 배치 분할', `size=${map2.size} groups=${JSON.stringify(groupSizes)}`);

    (mod.chunk(ids47, 50).length === 1 && mod.chunk(ids120, 50).length === 3)
      ? pass('chunk(50): 47→1배치 / 120→3배치')
      : fail('chunk(50)', `${mod.chunk(ids47, 50).length} / ${mod.chunk(ids120, 50).length}`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 4. channels.list subscriberCount 파싱 ──────────────────────────────────
async function testChannelsList(mod) {
  const origFetch = globalThis.fetch;
  process.env.YOUTUBE_API_KEY = 'TEST_KEY';
  const urls = [];
  globalThis.fetch = async (url, opts = {}) => {
    urls.push(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({
        items: [{
          id: 'UC_TEST', snippet: { title: '호기심 채널' },
          statistics: { subscriberCount: '141', viewCount: '24000', videoCount: '47', hiddenSubscriberCount: false },
        }],
      }),
    };
  };
  try {
    const c = await mod.fetchChannelStats({ token: 'fake-oauth-token', channelId: 'UC_TEST' });
    const keyFirst = urls[0].includes('key=TEST_KEY') && urls[0].includes('id=UC_TEST');
    (c.subscribers === 141 && c.views === 24000 && c.videos === 47 && c.channel_id === 'UC_TEST' && keyFirst && urls.length === 1)
      ? pass('channels.list: subscriberCount 141 파싱(API 키 경로 우선, 1회 호출)')
      : fail('channels.list 파싱', `${JSON.stringify(c)} urls=${JSON.stringify(urls)}`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ─── 5. 브리핑 본문 ─────────────────────────────────────────────────────────
async function testBriefing() {
  const rep = await import('../shorts-curiosity/analytics-report.mjs');
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const iso = (ago) => new Date(now - ago).toISOString();
  const snaps = [];
  const vids = [
    ['A', '상위영상 알파', 1000, 1200],
    ['B', '중간영상 베타', 500, 520],
    ['C', '중간영상 감마', 300, 320],
    ['D', '하위영상 델타', 100, 101],
  ];
  for (const [id, title, v0, v1] of vids) {
    snaps.push({ ts: iso(2 * DAY), youtube_id: id, subject: title, title, views: v0, likes: 1, comments: 0 });
    snaps.push({ ts: iso(0), youtube_id: id, subject: title, title, views: v1, likes: 2, comments: 1 });
  }
  const byId = new Map();
  for (const s of snaps) {
    if (!byId.has(s.youtube_id)) byId.set(s.youtube_id, []);
    byId.get(s.youtube_id).push(s);
  }
  const rows = rep.buildRows(byId);
  const daily = rep.buildDailyDelta(rows);
  const channel = rep.buildChannelSummary([
    { ts: iso(7 * DAY), subscribers: 120, views: 20000, videos: 47 },
    { ts: iso(0), subscribers: 141, views: 24000, videos: 47 },
  ], 500);
  const text = rep.buildBriefing({ rows, channel, daily, today: '2026-07-30' });

  (channel.subscribers === 141 && channel.remaining === 359 && channel.etaDays > 0)
    ? pass(`구독 요약: 141명 / 500 목표까지 359명 / ETA ${channel.etaDays}일(${channel.etaDate})`)
    : fail('구독 요약', JSON.stringify(channel));

  (daily.delta === 241 && daily.videos === 4)
    ? pass(`전일대비 조회 델타: +${daily.delta} (${daily.videos}편)`)
    : fail('전일대비 델타', JSON.stringify(daily));

  const hasGoal = text.includes('500') && text.includes('목표');
  const hasTop = text.includes('성과 상위 3편') && text.includes('상위영상 알파');
  const hasBottom = text.includes('성과 하위 3편') && text.includes('하위영상 델타');
  const topCount = (text.match(/^ {2}\d\. /gm) || []).length;
  (hasGoal && hasTop && hasBottom && topCount === 6)
    ? pass('브리핑: 500 목표 문구 + 상위3편/하위3편 포함')
    : fail('브리핑 본문', `goal=${hasGoal} top=${hasTop} bottom=${hasBottom} items=${topCount}\n${text}`);

  // 표본 부족 시 정직하게 산출불가
  const thin = rep.buildChannelSummary([{ ts: iso(0), subscribers: 10 }], 500);
  /산출불가/.test(thin.etaText) ? pass('구독 ETA: 표본 부족 → 산출불가 명시')
    : fail('구독 ETA 표본부족', thin.etaText);
  const flat = rep.buildChannelSummary([
    { ts: iso(7 * DAY), subscribers: 141 }, { ts: iso(0), subscribers: 141 },
  ], 500);
  /산출불가/.test(flat.etaText) ? pass('구독 ETA: 증가 0 → 산출불가 명시')
    : fail('구독 ETA 정체', flat.etaText);

  const blind = rep.buildBriefing({
    rows: [], channel: rep.buildChannelSummary([], 500), daily: { delta: null }, today: '2026-08-05',
  });
  (/성과 학습 중단/.test(blind) && /analytics-collect/.test(blind))
    ? pass('빈 애널리틱스는 단순 축적중이 아니라 성과 학습 중단으로 경고')
    : fail('빈 애널리틱스 학습중단 경고', blind);
}

// ─── 6. mock 리포트 실행 ────────────────────────────────────────────────────
async function testMockReport(tmp) {
  const stateDir = join(tmp, 'state-report');
  mkdirSync(stateDir, { recursive: true });
  const reportDir = join(tmp, 'reports');
  const r = await runScript('scripts/shorts-curiosity/analytics-report.mjs', {
    RUN_MODE: 'mock', STATE_DIR_OVERRIDE: stateDir,
    CURIOSITY_ANALYTICS_REPORT_DIR: reportDir, CURIOSITY_ANALYTICS_DRYRUN: '1',
  });
  const mds = existsSync(reportDir) ? readdirSync(reportDir).filter(f => f.endsWith('.md')) : [];
  if (r.code !== 0 || mds.length === 0) {
    return fail('mock 리포트 생성', `code=${r.code} mds=${mds.length} :: ${r.stderr.slice(0, 300)}`);
  }
  const md = readFileSync(join(reportDir, mds[0]), 'utf8');
  const ok = md.includes('500') && md.includes('상위') && md.includes('전일대비') && r.stdout.includes('목표');
  ok ? pass(`mock 리포트: ${mds[0]} 생성(구독목표·상위/하위·전일대비 포함), exit 0`)
     : fail('mock 리포트 내용', `md=${md.slice(0, 300)}`);
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'curiosity-analytics-'));
  try {
    await testMockCollect(tmp);
    const mod = await testAlertOncePerDay(tmp);
    testAlertBody(mod);
    await testVideosListFallback(mod);
    await testChannelsList(mod);
    await testBriefing();
    await testMockReport(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n호기심 성과 폐루프 스모크: ${passN} pass / ${failN} fail`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch(e => { console.error(`[curiosity-analytics test] 치명: ${e.message}\n${e.stack}`); process.exit(1); });
