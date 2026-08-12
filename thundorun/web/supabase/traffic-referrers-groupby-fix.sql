-- traffic-referrers-groupby-fix.sql
-- traffic_summary 의 top_referrers 중복집계 버그 수정 (2026-07-07, Mole 관측이 발견).
--
-- 문제: traffic_referrers 는 기본키 (date, referrer) — 리퍼러가 "날짜별 한 줄"로 쌓인다.
--       기존 top_referrers 는 group by 없이 원본 줄을 count 내림차순으로 뽑아,
--       기간(예: 7일) 조회 시 같은 referrer(www.google.com 등)가 날짜별로 여러 줄 중복 노출.
--       (top_paths·by_day 는 이미 group by 로 합산됨 — top_referrers 만 누락.)
-- 영향: Mole 인사이트 브리핑 + 관리자 대시보드 '유입 경로' 표시 양쪽에서 리퍼러 순위 왜곡.
-- 수정: top_referrers 도 referrer 로 group by 하고 sum(count) 로 기간 합산 (다른 지표와 동일 패턴).
--       그 외 로직은 traffic-admin-tag.sql 의 함수와 100% 동일(변경은 top_referrers 서브쿼리 뿐).
--
-- 적용: Supabase SQL Editor 에 붙여넣어 실행 (스키마 변경 없음·함수만 재정의·저위험·멱등).

create or replace function public.traffic_summary(p_from date, p_to date)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total_pv',  (select coalesce(sum(views), 0) from public.traffic_pv
                    where is_admin = false and date between p_from and p_to),
    'client_uv', (select count(*) from public.traffic_visitors
                    where is_admin = false and source = 'client' and date between p_from and p_to),
    'server_uv', (select count(*) from public.traffic_visitors
                    where is_admin = false and source = 'server' and date between p_from and p_to),
    'by_day',    (select coalesce(jsonb_agg(x.d order by x.d->>'date'), '[]'::jsonb) from (
                    select jsonb_build_object('date', date, 'pv', sum(views)) d
                    from public.traffic_pv where is_admin = false and date between p_from and p_to
                    group by date) x),
    'top_paths', (select coalesce(jsonb_agg(y.p), '[]'::jsonb) from (
                    select jsonb_build_object('path', path, 'pv', sum(views)) p
                    from public.traffic_pv where is_admin = false and date between p_from and p_to
                    group by path order by sum(views) desc limit 20) y),
    -- top_referrers 는 is_admin 필터가 없다(traffic_referrers 는 is_admin 태깅 대상 아님).
    -- 관리자 리퍼러는 의도적으로 실제 통계에 포함 — 동일호스트 리퍼러는 refHost()가 이미
    -- null 처리하므로 관리자 내부 이동은 안 잡히고, 외부 유입 리퍼러만 드물게 포함됨(수용).
    -- [FIX 2026-07-07] group by referrer + sum(count): 기간 내 날짜별 중복 줄을 리퍼러 단위로 합산.
    'top_referrers', (select coalesce(jsonb_agg(z.r), '[]'::jsonb) from (
                    select jsonb_build_object('referrer', referrer, 'count', sum(count)) r
                    from public.traffic_referrers where date between p_from and p_to
                    group by referrer order by sum(count) desc limit 20) z),
    'admin_pv', (select coalesce(sum(views), 0) from public.traffic_pv
                    where is_admin = true and date between p_from and p_to),
    'admin_client_uv', (select count(*) from public.traffic_visitors
                    where is_admin = true and source = 'client' and date between p_from and p_to),
    'admin_server_uv', (select count(*) from public.traffic_visitors
                    where is_admin = true and source = 'server' and date between p_from and p_to)
  );
$$;

-- PostgREST 스키마 캐시 리로드(함수 시그니처 불변이라 필수는 아니나 관례상 안전).
notify pgrst, 'reload schema';
