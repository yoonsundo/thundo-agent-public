/**
 * update-profile-career.mjs — Supabase site_profile(id=1) 행에 career 필드만 병합.
 *
 * 실행: node --env-file=.env.local scripts/update-profile-career.mjs
 *
 * 원칙(merge-only): 기존 data 의 다른 필드(name·bio·socials …)는 건드리지 않는다.
 * career 원본은 src/server/career.default.json 단일 소스 — 코드 폴백과 DB 가 같은 값을 본다.
 * 이름은 'Thundo' 유지가 사용자 결정(계획 §0 Q2)이므로 name 은 절대 쓰지 않는다.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const career = JSON.parse(
  readFileSync(join(here, '../src/server/career.default.json'), 'utf-8'),
);

// NEXT_PUBLIC_* 는 웹 관례, SUPABASE_URL 은 blog-publisher .env 관례 — 같은 프로젝트라 둘 다 허용.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('환경변수 누락: NEXT_PUBLIC_SUPABASE_URL(또는 SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY');
  console.error('실행: node --env-file=.env.local scripts/update-profile-career.mjs');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const { data: row, error: readErr } = await db
  .from('site_profile')
  .select('data')
  .eq('id', 1)
  .maybeSingle();

if (readErr) {
  console.error('site_profile 읽기 실패:', readErr.message);
  process.exit(1);
}

const existing = row?.data ?? {};
const merged = { ...existing, career };

const { error: writeErr } = await db
  .from('site_profile')
  .upsert({ id: 1, data: merged, updated_at: new Date().toISOString() });

if (writeErr) {
  console.error('site_profile upsert 실패:', writeErr.message);
  process.exit(1);
}

console.log(`OK — career ${career.length}건 병합 완료 (기존 필드 ${Object.keys(existing).length}개 보존)`);
