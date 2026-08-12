#!/usr/bin/env node
/**
 * scripts/test/hub.mjs — CEO 업무 브리핑·소통 창고(Comms Hub) 통합 테스트
 *
 * 검증 항목 (PRD US-001~006 핵심 합격기준):
 *   US-001 store: append-only 4종 레코드 + timeline 통합 + 경로 격리
 *   US-002 briefing: run.json → 4섹션 + persist
 *   US-003 commands: 안전 명령 3종 화이트리스트 + 비안전 거부 + killswitch 연동
 *   US-004 query: 데이터근거 인텐트 응답 + none 정직 거절
 *   US-005 telegram-bot: 명령/질의 라우팅 + 브리핑 push
 *   US-006 server: route 토큰검증 + 비안전 거부 + 대시보드 4섹션 HTML
 *
 * 격리: STATE_DIR_OVERRIDE + KILL_SWITCH_PATH 를 임시 디렉토리로 지정해
 *       실제 state/·.kill-switch·감사로그를 건드리지 않는다.
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename  = fileURLToPath(import.meta.url);
const TEST_DIR    = dirname(__filename);
const SCRIPTS_DIR = resolve(TEST_DIR, '..');
const HUB_DIR     = join(SCRIPTS_DIR, 'hub');

// ─── 격리 환경 구성 (import 전에 env 설정해야 config.mjs paths 가 반영됨) ───────
const SANDBOX = mkdtempSync(join(tmpdir(), 'hub-test-'));
process.env.STATE_DIR_OVERRIDE = SANDBOX;
process.env.KILL_SWITCH_PATH   = join(SANDBOX, '.kill-switch');
process.env.AUDIT_DIR_OVERRIDE = join(SANDBOX, 'audit');     // 실제 감사체인 오염 방지
process.env.MOCK_OUT_OVERRIDE  = join(SANDBOX, 'mock-out');  // .mock-out 오염 방지
process.env.AUDIT_SIGNING_KEY  = process.env.AUDIT_SIGNING_KEY || '';
// store-supabase 어댑터를 JSONL 폴백으로 강제 — 통합 store(writer=store-supabase)를
// 쓰므로 .env 의 실 Supabase 크리덴셜이 있으면 테스트가 원격 DB 를 건드린다.
// 빈 문자열로 선점하면 config.mjs 의 .env 로더가 덮어쓰지 않아 JSONL(sandbox) 폴백.
process.env.SUPABASE_URL              = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.SUPABASE_SERVICE_ROLE     = '';
// 모든 쓰기(state·감사로그·mock출력)를 샌드박스로 격리 — test:hub 가
// 실제 거버넌스 감사로그에 테스트 명령을 남기지 않는다.

// ─── 결과 집계 ────────────────────────────────────────────────────────────────
let passCount = 0;
let failCount = 0;
function pass(label) { console.log(`  [PASS] ${label}`); passCount++; }
function fail(label, detail = '') { console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`); failCount++; }
function check(cond, label, detail = '') { cond ? pass(label) : fail(label, detail); }

async function main() {
  console.log(`\n=== Comms Hub 통합 테스트 (sandbox: ${SANDBOX}) ===\n`);

  const store    = await import(join(HUB_DIR, 'store.mjs'));
  const briefing = await import(join(HUB_DIR, 'briefing.mjs'));
  const commands = await import(join(HUB_DIR, 'commands.mjs'));
  const query    = await import(join(HUB_DIR, 'query.mjs'));
  const bot      = await import(join(HUB_DIR, 'telegram-bot.mjs'));
  const server   = await import(join(HUB_DIR, 'server.mjs'));

  // ── US-001 store ────────────────────────────────────────────────────────────
  console.log('US-001 store');
  const b = store.appendRecord('briefing', { date: '2026-06-26', summary: 's' });
  store.appendRecord('command', { kind: 'pause_resume' });
  store.appendRecord('decision', { topic: 't', choice: 'approve' });
  store.appendRecord('message', { role: 'ceo', question: 'q' });
  check(!!b.id && !!b.ts, 'appendRecord 가 id·ts 자동부여');
  const tl = store.timeline({ limit: 50 });
  check(tl.length >= 4, 'timeline 4종 통합', `len=${tl.length}`);
  const types = new Set(tl.map(r => r.type));
  check(['briefing','command','decision','message'].every(t => types.has(t)), 'timeline 에 4종 모두 존재');
  check(tl[0].ts >= tl[tl.length - 1].ts, 'timeline ts 역순 정렬');
  let threw = false;
  try { store.appendRecord('bogus', {}); } catch { threw = true; }
  check(threw, '알 수 없는 type 거부');

  // ── US-002 briefing ─────────────────────────────────────────────────────────
  console.log('US-002 briefing');
  const run = briefing.loadLatestRun();
  const bf = briefing.buildBriefing(run || {}, {});
  check(bf && 'yesterday' in bf && 'budget' in bf && 'alerts' in bf && 'decisions' in bf,
    'buildBriefing 4섹션 반환', JSON.stringify(Object.keys(bf || {})));
  const text = briefing.formatBriefingText(bf);
  check(typeof text === 'string' && text.length > 0, 'formatBriefingText 텍스트 반환');
  const gen = await briefing.generateBriefing();
  check(!!gen && !!gen.id, 'generateBriefing persist');
  check(store.readRecords('briefing').length >= 2, '브리핑이 store 에 누적');

  // ── US-003 commands ─────────────────────────────────────────────────────────
  console.log('US-003 commands');
  const safe = commands.SAFE_COMMANDS;
  const safeKeys = Array.isArray(safe) ? safe : Object.keys(safe);
  check(safeKeys.length === 3
    && ['pause_resume','topic_decision','rerun'].every(k => safeKeys.includes(k)),
    'SAFE_COMMANDS 정확히 3종', JSON.stringify(safeKeys));
  const rej = await commands.executeCommand({ type: 'delete_all', args: {} });
  check(rej.ok === false && rej.rejected === true, '비안전 명령 거부');
  const paused = await commands.executeCommand({ type: 'pause_resume', args: { action: 'pause' } });
  check(paused.ok === true, 'pause_resume(pause) 허용');
  const ks = await import(join(SCRIPTS_DIR, 'watchdog', 'killswitch.mjs'));
  const killState = await ks.isKilled();
  check(killState.active === true, 'pause 가 killswitch 실제 활성화');
  const resumed = await commands.executeCommand({ type: 'pause_resume', args: { action: 'resume' } });
  check(resumed.ok === true && (await ks.isKilled()).active === false, 'resume 가 killswitch 해제');
  const dec = await commands.executeCommand({ type: 'topic_decision', args: { topic: 'x', choice: 'approve' } });
  check(dec.ok === true, 'topic_decision(approve) 허용');
  check(store.readRecords('decision').length >= 1, '결정이 store 에 기록');
  const rerun = await commands.executeCommand({ type: 'rerun', args: { target: 'last' } });
  check(rerun.ok === true, 'rerun 허용');
  check(store.readRecords('command').length >= 1, '명령이 store 에 기록');

  // ── US-004 query ────────────────────────────────────────────────────────────
  console.log('US-004 query');
  const qBudget = query.answerQuery('이번 예산 어때?');
  check(qBudget.matched && qBudget.matched !== 'none', '예산 질의 인텐트 매칭', qBudget.matched);
  const qNone = query.answerQuery('내일 날씨 알려줘');
  check(qNone.matched === 'none' && (qNone.basis === null || qNone.basis === undefined),
    '근거없는 질의 정직 거절(환각 금지)');
  // answerQuery 는 더 이상 store 에 직접 쓰지 않는다(영속화는 표면 레이어 책임 — 통합 store 중복 방지).
  // 데이터근거 응답이 비어있지 않은지로 품질을 검증한다.
  check(typeof qBudget.answer === 'string' && qBudget.answer.length > 0,
    '예산 질의가 데이터근거 응답 텍스트 생성');

  // ── US-005 telegram-bot ─────────────────────────────────────────────────────
  console.log('US-005 telegram-bot');
  const rCmd = await bot.handleIncoming('파이프라인 멈춰');
  check(rCmd.kind === 'command', "'멈춰' → command 라우팅", rCmd.kind);
  await bot.handleIncoming('재개해'); // 정리: 킬 해제
  const rQ = await bot.handleIncoming('오늘 몇 편 발행?');
  check(rQ.kind === 'query', "질문 → query 라우팅", rQ.kind);
  const pushed = await bot.pushBriefing();
  check(pushed && pushed.pushed === true, 'pushBriefing 동작');

  // ── US-006 server ───────────────────────────────────────────────────────────
  console.log('US-006 server');
  process.env.HUB_DASHBOARD_TOKEN = 'secret';
  const noTok = await server.route('POST', '/api/command', { type: 'pause_resume', args: { action: 'pause' } }, {});
  check(noTok.status === 401, 'POST 토큰없음 401', `status=${noTok.status}`);
  const okTok = await server.route('POST', '/api/command', { type: 'pause_resume', args: { action: 'resume' } }, { 'x-hub-token': 'secret' });
  check(okTok.status === 200, 'POST 올바른 토큰 200', `status=${okTok.status}`);
  const unsafe = await server.route('POST', '/api/command', { type: 'delete_all' }, { 'x-hub-token': 'secret' });
  check(unsafe.json && unsafe.json.rejected === true, 'server 비안전 명령 거부');
  const tlRoute = await server.route('GET', '/api/timeline', null, {});
  check(tlRoute.status === 200 && Array.isArray(tlRoute.json), 'GET /api/timeline 토큰불요 200');
  const html = server.renderDashboard();
  check(html.includes('어제') && html.includes('예산') && html.includes('알람') || html.includes('이상'),
    '대시보드 HTML 4섹션 포함');

  // ── 결과 ─────────────────────────────────────────────────────────────────────
  console.log(`\n=== 결과: ${passCount} PASS / ${failCount} FAIL ===`);
  return failCount === 0 ? 0 : 1;
}

main()
  .then(code => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} process.exit(code); })
  .catch(err => {
    console.error('[test:hub] 치명적 오류:', err);
    try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
