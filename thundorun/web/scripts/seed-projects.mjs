/**
 * seed-projects.mjs — projects 테이블에 기본 콘텐츠(포트폴리오 프로젝트) 시딩.
 *
 * 전제: supabase/projects.sql 로 projects 테이블이 먼저 생성돼 있어야 한다(PostgREST는 DDL 불가).
 * 동작: src/server/projects.default.json 을 읽어 on_conflict=id 로 upsert(멱등).
 * 환경: .env.local 의 NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * 실행: node scripts/seed-projects.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// .env.local 로더(외부 의존성 없이)
function loadEnv() {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

if (!URL || !KEY) {
  console.error('[seed-projects] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정.');
  process.exit(2);
}

const projects = JSON.parse(readFileSync(join(ROOT, 'src', 'server', 'projects.default.json'), 'utf8'));

async function main() {
  const now = new Date().toISOString();
  const rows = projects.map((p) => ({ ...p, role: p.role ?? null, link: p.link ?? null, updated_at: now }));

  // PostgREST upsert: on_conflict=id + merge-duplicates
  const res = await fetch(`${URL.replace(/\/$/, '')}/rest/v1/projects?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey:         KEY,
      Authorization:  `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[seed-projects] upsert 실패 HTTP ${res.status}: ${detail.slice(0, 300)}`);
    if (res.status === 404 || /relation .*projects.* does not exist/i.test(detail)) {
      console.error('→ projects 테이블이 없습니다. 먼저 supabase/projects.sql 을 Supabase SQL 에디터에서 실행하세요.');
    }
    process.exit(1);
  }
  console.log(`[seed-projects] ${rows.length}개 프로젝트 upsert 완료.`);
  process.exit(0);
}

main().catch((e) => { console.error('[seed-projects] 오류:', e.message); process.exit(1); });
