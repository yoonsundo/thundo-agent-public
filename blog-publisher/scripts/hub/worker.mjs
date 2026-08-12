/**
 * hub/worker.mjs — 소통 창고 상시 워커 데몬
 *
 * 역할:
 *   - mock 인박스(.mock-out/hub-inbox.jsonl)를 2초마다 폴링
 *   - 미처리 메시지를 handleIncoming() 으로 처리
 *   - 사용자 메시지 + 봇 응답을 state/hub/message.jsonl 에 append
 *   - 30초마다 state/hub/worker-heartbeat.json 에 하트비트 기록
 *
 * 중복 응답 방지:
 *   - 웹 채팅(POST /api/admin/message)은 별도 웹 레이어에서 즉답하므로
 *     이 워커는 인박스(외부 소스) 메시지만 처리한다.
 *
 * 실행:
 *   npm run hub:worker  (RUN_MODE=mock 자동 적용)
 *   SIGINT(Ctrl+C)로 그레이스풀 종료.
 *
 * 주의 — Vercel 서버리스 배포 시:
 *   Vercel Serverless Functions 는 장시간 상주 데몬을 지원하지 않습니다.
 *   이 워커는 별도 상시 호스트(Node.js 서버, Railway, Render 등)에서 실행해야 합니다.
 *   dev(npm run hub:worker) 환경에서는 완전 동작합니다.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join }                                  from 'node:path';
import { pollMockInbox }                         from './telegram-bot.mjs';
import { appendRecord }                          from './store-supabase.mjs';
import { isMock, paths }                         from '../lib/config.mjs';
import { makeLogger }                            from '../lib/log.mjs';

const log             = makeLogger('hub/worker');
const POLL_MS         = 2_000;   // inbox 폴링 주기
const HEARTBEAT_MS    = 30_000;  // 하트비트 기록 주기

let running = true;

// ─── 그레이스풀 종료 ──────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  log.info('SIGINT 수신 — 그레이스풀 종료 중…');
  running = false;
});

process.on('SIGTERM', () => {
  log.info('SIGTERM 수신 — 그레이스풀 종료 중…');
  running = false;
});

// ─── 하트비트 ─────────────────────────────────────────────────────────────────
function writeHeartbeat() {
  try {
    const dir  = join(paths.state, 'hub');
    const path = join(dir, 'worker-heartbeat.json');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, mode: isMock() ? 'mock' : 'live' }), 'utf8');
  } catch (err) {
    log.warn('하트비트 기록 실패', err?.message);
  }
}

// ─── 폴링 1회 ─────────────────────────────────────────────────────────────────
async function pollOnce() {
  if (!isMock()) {
    // live 모드: Telegram getUpdates 는 pollLiveUpdates — 여기서는 mock 전용
    log.warn('워커는 mock 모드 전용입니다. RUN_MODE=mock 으로 실행하세요.');
    return;
  }

  let results;
  try {
    results = await pollMockInbox();
  } catch (err) {
    log.error('pollMockInbox 오류', err?.message);
    return;
  }

  for (const { text, kind, reply } of results) {
    // 인박스 메시지(외부 소스)와 봇 응답을 store 에 기록
    try {
      await appendRecord('message', { from: 'telegram-mock', text, actor: 'ceo' });
    } catch (err) {
      log.warn('사용자 메시지 append 실패', err?.message);
    }
    try {
      await appendRecord('message', { from: 'bot', text: reply, kind, actor: 'system' });
    } catch (err) {
      log.warn('봇 응답 append 실패', err?.message);
    }
    log.info(`처리 완료: [${kind}] ${reply.slice(0, 60)}`);
  }
}

// ─── 메인 루프 ────────────────────────────────────────────────────────────────
async function main() {
  log.info(`워커 시작 (PID=${process.pid}, mode=${isMock() ? 'mock' : 'live'})`);
  writeHeartbeat();

  let lastHeartbeat = Date.now();

  while (running) {
    await pollOnce();

    // 하트비트 주기 확인
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      writeHeartbeat();
      lastHeartbeat = Date.now();
    }

    // POLL_MS 대기 (running 체크로 즉시 종료 가능)
    await new Promise((resolve) => {
      const t = setTimeout(resolve, POLL_MS);
      // 종료 신호 오면 즉시 resolve
      const check = setInterval(() => {
        if (!running) { clearTimeout(t); clearInterval(check); resolve(undefined); }
      }, 100);
      // 타임아웃이 먼저 끝나면 check 정리
      setTimeout(() => clearInterval(check), POLL_MS + 50);
    });
  }

  log.info('워커 정상 종료');
  process.exit(0);
}

main().catch((err) => {
  log.error('워커 치명적 오류', err?.message ?? String(err));
  process.exit(1);
});
