/**
 * lib/supabase-creds.mjs — 서비스롤 Supabase 접속 정보 한 곳.
 *
 * 같은 구현이 `board/approvals.mjs` 와 `board/publish-board.mjs` 에 글자 그대로 두 벌 있었고,
 * 감시견(`watchdog/pipeline-health.mjs`)은 크리덴셜 하나가 필요해서 **도메인 모듈을 import** 했다
 * — 감시하는 쪽이 감시 대상에 의존하는 모양이라 방향이 거꾸로였다.
 *
 * ⚠ 여기 있는 것은 **서비스롤 조합 하나뿐**이다. `audit/supabase-mirror.mjs`(anon 키)와
 *    `hub/repair-blog-titles.mjs`(다른 폴백 순서)는 실제로 다른 값을 읽으므로 합치지 않았다 —
 *    겉모양이 닮았다고 묶으면 읽는 값이 조용히 바뀐다.
 */
import { readFileSync, existsSync } from 'node:fs';

/** `.env` 형식 파일에서 키 하나. 없으면 null(던지지 않는다 — 크리덴셜 부재는 정상 경로다). */
export function envFrom(file, key) {
  try {
    if (!existsSync(file)) return null;
    const m = readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

/**
 * 프로세스 env → 레포 `.env` → 사이트 레포 `.env.local` 순.
 * 사이트 쪽은 URL 을 `NEXT_PUBLIC_` 접두어로 들고 있어 이름이 다르다.
 */
export function supabaseCreds() {
  const url = process.env.SUPABASE_URL || envFrom('.env', 'SUPABASE_URL')
    || envFrom('repo/thundorun/web/.env.local', 'NEXT_PUBLIC_SUPABASE_URL');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || envFrom('.env', 'SUPABASE_SERVICE_ROLE_KEY')
    || envFrom('repo/thundorun/web/.env.local', 'SUPABASE_SERVICE_ROLE_KEY');
  return { url: url ? url.replace(/\/$/, '') : null, key };
}
