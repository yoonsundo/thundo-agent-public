/**
 * watchdog/lock.mjs — 중복 실행 방지 lockfile
 * §D2 step 0: flock(중첩방지)
 * Node 내장만 사용. 파일 존재 기반 + PID 기록.
 * mock/live 공통 동작.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('watchdog/lock');

// ─── 경로 ─────────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function lockPath(date) {
  const d = date || todayStr();
  return join(paths.runs, d, 'run.lock');
}

function ensureRunDir(date) {
  const d   = date || todayStr();
  const dir = join(paths.runs, d);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── PID 생존 확인 ────────────────────────────────────────────────────────────

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // kill(pid, 0): 프로세스 존재 확인용 (신호 미전송)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * acquireLock(date?) → { acquired: boolean, lockPath, pid?, lockedAt? }
 * 이미 lock이 있고 PID가 살아있으면 acquired=false.
 * stale lock(PID 사망)이면 자동 해제 후 취득.
 */
export function acquireLock(date) {
  ensureRunDir(date);
  const p = lockPath(date);

  if (existsSync(p)) {
    let lockData = {};
    try {
      lockData = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // 파싱 실패 → stale 간주
      log.warn('lock 파일 파싱 실패 — stale로 간주하고 해제');
    }

    const stalePid = lockData.pid;
    if (stalePid && isPidAlive(stalePid)) {
      return { acquired: false, lockPath: p, pid: stalePid, lockedAt: lockData.locked_at };
    }
    // stale lock — 자동 해제
    log.warn(`stale lock 감지 (PID ${stalePid}) — 자동 해제`);
    try {
      unlinkSync(p);
    } catch (err) {
      log.error('stale lock 삭제 실패', err);
    }
  }

  const entry = {
    pid:       process.pid,
    locked_at: new Date().toISOString(),
  };
  try {
    writeFileSync(p, JSON.stringify(entry, null, 2), 'utf8');
  } catch (err) {
    log.error('lock 파일 쓰기 실패', err);
    return { acquired: false, lockPath: p, error: err.message };
  }
  return { acquired: true, lockPath: p, pid: process.pid };
}

/**
 * releaseLock(date?) → void
 * 자신의 PID가 소유한 lock만 해제.
 */
export function releaseLock(date) {
  const p = lockPath(date);
  if (!existsSync(p)) return;

  try {
    const lockData = JSON.parse(readFileSync(p, 'utf8'));
    if (lockData.pid !== process.pid) {
      log.warn(`다른 PID(${lockData.pid})의 lock — 해제 건너뜀`);
      return;
    }
  } catch {
    // 파싱 실패 — 그냥 삭제
  }

  try {
    unlinkSync(p);
    log.info(`lock 해제: ${p}`);
  } catch (err) {
    log.error('lock 파일 삭제 실패', err);
  }
}

/**
 * isLocked(date?) → boolean
 * 활성 lock 존재 여부.
 */
export function isLocked(date) {
  const p = lockPath(date);
  if (!existsSync(p)) return false;
  try {
    const lockData = JSON.parse(readFileSync(p, 'utf8'));
    return isPidAlive(lockData.pid);
  } catch {
    return false;
  }
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('lock.mjs')) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    console.log('locked:', isLocked());
  } else if (cmd === 'acquire') {
    console.log(JSON.stringify(acquireLock(), null, 2));
  } else if (cmd === 'release') {
    releaseLock();
  }
}
