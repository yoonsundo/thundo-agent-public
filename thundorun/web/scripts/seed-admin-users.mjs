#!/usr/bin/env node
/**
 * seed-admin-users.mjs — Supabase admin_users 테이블 초기 시드
 *
 * 사용법:
 *   # .env.local 에 환경변수 설정 후 (Node 20+):
 *   node --env-file=.env.local scripts/seed-admin-users.mjs
 *
 *   # 또는 직접 env 지정:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     ADMIN_ID=myid ADMIN_PASSWORD=mypassword \
 *     node scripts/seed-admin-users.mjs
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL    — Supabase 프로젝트 URL (필수)
 *   SUPABASE_SERVICE_ROLE_KEY   — service_role 키 (필수, 서버 전용)
 *   ADMIN_ID                    — admin 계정 ID (필수)
 *   ADMIN_PASSWORD              — admin 계정 비밀번호 (필수)
 *   USER_ID                     — user 계정 ID (선택)
 *   USER_PASSWORD               — user 계정 비밀번호 (선택)
 *
 * 동작: scrypt 해시 후 admin_users에 upsert (id 충돌 시 password_hash 갱신).
 * 비밀번호 평문은 메모리에서만 사용하고 저장하지 않는다.
 */

import { scryptSync, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// ─── scrypt 유틸 ────────────────────────────────────────────────────────────
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${derived}`;
}

// ─── env 검증 ────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_ID     = process.env.ADMIN_ID;
const ADMIN_PW     = process.env.ADMIN_PASSWORD;
const USER_ID      = process.env.USER_ID;
const USER_PW      = process.env.USER_PASSWORD;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[seed] NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 미설정.');
  process.exit(1);
}
if (!ADMIN_ID || !ADMIN_PW) {
  console.error('[seed] ADMIN_ID / ADMIN_PASSWORD 미설정.');
  process.exit(1);
}

// ─── Supabase 클라이언트 (service_role) ──────────────────────────────────────
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─── upsert 헬퍼 ─────────────────────────────────────────────────────────────
async function upsertUser(id, password, role) {
  const password_hash = hashPassword(password);
  const { error } = await db
    .from('admin_users')
    .upsert(
      { id, password_hash, role, created_at: new Date().toISOString() },
      { onConflict: 'id' },
    );
  if (error) {
    console.error(`[seed] ${id}(${role}) upsert 실패:`, error.message);
    return false;
  }
  console.log(`[seed] ${id}(${role}) — OK`);
  return true;
}

// ─── 실행 ────────────────────────────────────────────────────────────────────
let ok = true;

ok = (await upsertUser(ADMIN_ID, ADMIN_PW, 'admin')) && ok;

if (USER_ID && USER_PW) {
  ok = (await upsertUser(USER_ID, USER_PW, 'user')) && ok;
} else {
  console.log('[seed] USER_ID / USER_PASSWORD 미설정 — user 계정 건너뜀.');
}

process.exit(ok ? 0 : 1);
