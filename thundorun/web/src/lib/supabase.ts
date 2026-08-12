import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_client) {
    // ⚠ `cache: 'no-store'` 를 전역 강제하지 않는다.
    //
    //   예전엔 "새 글이 목록에 안 뜨는" 문제를 막으려 모든 fetch 에 no-store 를 걸었다.
    //   그런데 no-store fetch 는 **그 라우트를 통째로 동적 렌더링으로 강등**시킨다. 그래서
    //   `revalidate = 300` 을 선언한 홈까지 방문마다 전체 렌더가 돌았고, 운영에서
    //   `cache-control: no-store` + `x-vercel-cache: MISS` 로 나타났다(실측 2026-08-11).
    //   ※ 크리덴셜 없는 로컬 빌드에선 fetch 가 아예 없어 홈이 ○(Static) 으로 보인다 —
    //     이 증상은 **크리덴셜을 넣고 빌드해야** 재현된다(ƒ 로 바뀜). 이것 때문에 원인을
    //     한 번 잘못 짚었다(next.config 의 output:'standalone' 으로 오인).
    //
    //   캐시 정책은 라우트가 정한다:
    //     - `dynamic = 'force-dynamic'`(관리자·API) → Next 가 fetch 를 no-store 로 처리
    //     - `revalidate = N`(홈 등 공개 화면)       → N 초 뒤 재검증
    //   신선도가 필요한 화면은 각자 선언하면 되고, 전역 강제는 그 선언을 무력화할 뿐이다.
    _client = createClient(url, key);
  }
  return _client;
}
