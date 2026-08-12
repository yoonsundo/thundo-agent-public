/**
 * server/hub/killswitch.ts — 킬스위치 (watchdog/killswitch.mjs 최소 이식)
 * state/hub/killswitch.json 에 중단 의도를 기록.
 * Vercel 서버리스 환경에서는 파일 쓰기 실패를 graceful하게 처리.
 * 실제 blog-publisher 프로세스 중단은 파이프라인이 hub_commands 테이블을 폴링해 수행.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import { paths } from './config';
import { makeLogger } from './logger';

const log = makeLogger('hub/killswitch');

interface KillState {
  killed: boolean;
  reason?: string;
  ts?: string;
}

function killPath(): string {
  const dir = path.join(paths.state, 'hub');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* Vercel read-only */ }
  return path.join(dir, 'killswitch.json');
}

function readState(): KillState {
  try {
    const p = killPath();
    if (!existsSync(p)) return { killed: false };
    return JSON.parse(readFileSync(p, 'utf8')) as KillState;
  } catch { return { killed: false }; }
}

export function setLocalKill(reason: string): void {
  try {
    writeFileSync(killPath(), JSON.stringify({ killed: true, reason, ts: new Date().toISOString() }), 'utf8');
    log.info(`킬스위치 설정: ${reason}`);
  } catch (err) {
    // Vercel 등 read-only 파일시스템 — 조용히 무시 (store command record 가 의도 보존)
    log.warn('킬스위치 파일 쓰기 실패 (read-only 환경)', err);
  }
}

export function clearLocalKill(): void {
  try {
    const p = killPath();
    if (existsSync(p)) unlinkSync(p);
    log.info('킬스위치 해제');
  } catch (err) {
    log.warn('킬스위치 파일 삭제 실패', err);
  }
}

export async function isKilled(): Promise<boolean> {
  return readState().killed;
}
