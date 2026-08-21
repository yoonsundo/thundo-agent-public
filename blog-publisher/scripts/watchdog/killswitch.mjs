/**
 * watchdog/killswitch.mjs — 킬 플래그 read/check
 * §D1/§D2: mock=로컬파일, live=Supabase kill_switch 행 SELECT
 * 에이전트는 anon SELECT만(UPDATE RLS 거부 — 2nd distro 전용).
 * 파일킬은 탐지만, Supabase가 진짜 예방.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isMock, env, paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('watchdog/killswitch');

// ─── 로컬 파일 킬스위치 경로 ─────────────────────────────────────────────────

function localKillPath() {
  const explicit = env('KILL_SWITCH_PATH');
  if (explicit) return explicit;
  return join(paths.root, '.kill-switch');
}

// ─── mock: 로컬파일 기반 ──────────────────────────────────────────────────────

function readLocalKill() {
  const p = localKillPath();
  if (!existsSync(p)) return { active: false, source: 'local-file', note: '파일 없음' };
  try {
    const content = readFileSync(p, 'utf8').trim();
    const data    = content ? JSON.parse(content) : {};
    return {
      active: data.active === true,
      reason: data.reason || '킬스위치 파일 존재',
      set_at: data.set_at || null,
      source: 'local-file',
    };
  } catch {
    // 파일 내용 파싱 실패 → 존재 자체를 kill 신호로 간주
    log.warn('킬스위치 파일 파싱 실패 — kill 활성으로 간주');
    return { active: true, reason: '킬스위치 파일 파싱 실패', source: 'local-file' };
  }
}

// ─── live: Supabase anon SELECT ───────────────────────────────────────────────

async function readSupabaseKill() {
  const supabaseUrl = env('SUPABASE_URL');
  const anonKey     = env('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !anonKey) {
    log.warn('Supabase 크리덴셜 없음 — 로컬 파일로 폴백');
    return readLocalKill();
  }

  const url = `${supabaseUrl}/rest/v1/kill_switch?select=active,reason,set_at&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        'apikey':        anonKey,
        'Authorization': `Bearer ${anonKey}`,
        'Accept':        'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log.warn(`Supabase 응답 ${res.status} — 로컬 폴백`);
      return readLocalKill();
    }

    let rows;
    try {
      rows = await res.json();
    } catch (err) {
      log.warn('Supabase 응답 JSON 파싱 실패 — 로컬 폴백', err);
      return readLocalKill();
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return { active: false, source: 'supabase', note: '행 없음' };
    }

    const row = rows[0];
    return {
      active: row.active === true,
      reason: row.reason || null,
      set_at: row.set_at || null,
      source: 'supabase',
    };
  } catch (err) {
    log.warn(`Supabase 요청 실패 — 로컬 폴백: ${err.message}`);
    return readLocalKill();
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * isKilled() → { active: boolean, reason?, source }
 * mock: 로컬파일 체크
 * live: Supabase anon SELECT (실패 시 로컬 폴백)
 */
export async function isKilled() {
  if (isMock()) return readLocalKill();
  return readSupabaseKill();
}

/**
 * assertNotKilled() → void (killed이면 throw)
 */
export async function assertNotKilled() {
  const status = await isKilled();
  if (status.active) {
    throw new Error(
      `[killswitch] KILL ACTIVE — ${status.reason || '이유 없음'} (source: ${status.source})`
    );
  }
}

/**
 * setLocalKill(reason) — mock/테스트 전용. 로컬파일에 킬 플래그 설정.
 */
export function setLocalKill(reason = '수동 킬') {
  const p    = localKillPath();
  const data = { active: true, reason, set_at: new Date().toISOString() };
  try {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    log.info(`로컬 킬 설정: ${p}`);
  } catch (err) {
    log.error('킬스위치 파일 쓰기 실패', err);
  }
}

/**
 * clearLocalKill() — mock/테스트 전용.
 */
export function clearLocalKill() {
  const p = localKillPath();
  if (existsSync(p)) {
    try {
      unlinkSync(p);
      log.info(`로컬 킬 해제: ${p}`);
    } catch (err) {
      log.error('킬스위치 파일 삭제 실패', err);
    }
  }
}

// CLI
if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'check') {
    isKilled().then(s => console.log(JSON.stringify(s, null, 2)));
  } else if (cmd === 'set') {
    setLocalKill(process.argv[3] || '수동 킬 (CLI)');
  }
}
