-- traffic-admin-tag.sql — 관리자(role=admin) 테스트 방문을 실제 트래픽과 분리 집계.
--
-- 목적: 로그인 관리자 본인의 테스트 방문을 버리지 않고 집계하되, 실제 외부 트래픽
--       (is_admin=false)과 분리해 대시보드에 따로 표시. 식별은 IP가 아니라 next-auth
--       세션 토큰의 role 로만 한다(원본 IP 저장 없음 — 기존 HMAC 비가역 설계 유지).
--
-- 설계: traffic_pv / traffic_visitors / traffic_pv_seen 3개 테이블에 is_admin 차원 추가.
--       기존 집계 RPC(bump_pv_guarded / bump_uv / bump_uv_client)는 p_is_admin 인자를
--       추가로 받아 태깅. traffic_summary 는 실제 트래픽(is_admin=false)만 기존 키로 주고,
--       관리자 전용 집계 3키(admin_pv / admin_client_uv / admin_server_uv)를 신설.
--
-- 멱등: 2회 적용 안전(add column if not exists, drop constraint/function if exists 후 재생성).
--       기존 행은 default false 로 채워져 실제 트래픽으로 보존됨.
--
-- ⚠ 적용은 운영자 몫: 사이트 코드(middleware / /api/pv)가 새 컬럼·시그니처(p_is_admin)에
--   의존하므로, 새 코드 배포 전에 이 SQL 을 Supabase 에 먼저 적용해야 한다.
--
-- ⚠ 런북: 적용(apply) 후 PostgREST가 새 함수 시그니처를 인식하려면 스키마 캐시 리로드가
--   필요하다. Supabase는 보통 DDL 감지로 자동 리로드하나, 즉시 반영하려면
--   `NOTIFY pgrst, 'reload schema';` 를 실행하고, **리로드 확인 후 코드 배포**하라.

-- ── 1) is_admin 컬럼 추가(기존 행은 default false) ───────────────────────────────
alter table public.traffic_pv       add column if not exists is_admin boolean not null default false;
alter table public.traffic_visitors add column if not exists is_admin boolean not null default false;
alter table public.traffic_pv_seen  add column if not exists is_admin boolean not null default false;

-- ── 2) PK 를 is_admin 포함으로 재구성(관리자/실제 트래픽을 별도 행으로 분리) ────────
alter table public.traffic_pv       drop constraint if exists traffic_pv_pkey;
alter table public.traffic_visitors drop constraint if exists traffic_visitors_pkey;
alter table public.traffic_pv_seen  drop constraint if exists traffic_pv_seen_pkey;

alter table public.traffic_pv       add primary key (date, hour, path, is_admin);
alter table public.traffic_visitors add primary key (date, visitor_id, source, is_admin);
alter table public.traffic_pv_seen  add primary key (date, path, visitor, is_admin);

-- ── 3) 기존 RPC 오버로드 충돌 방지: 정확한 기존 시그니처를 drop 후 재생성 ───────────
--     (arity 가 바뀌므로 create or replace 로는 새 오버로드가 생겨 호출 모호성이 생김)
drop function if exists public.bump_pv_guarded(date, smallint, text, text, int, int);
drop function if exists public.bump_uv(date, text, text, int);
drop function if exists public.bump_uv_client(date, text, text, int, int);

-- ── RPC: dedup PV 증분 (+ is_admin 태깅). dedup 키·집계 키 양쪽에 is_admin 반영. ──
create or replace function public.bump_pv_guarded(
  p_date date, p_hour smallint, p_path text, p_visitor text,
  p_cooldown_min int default 30, p_cap int default 200000,
  p_is_admin boolean default false)
returns boolean language plpgsql as $$
declare cnt int; prev timestamptz;
begin
  if p_visitor is null or p_visitor = '' then          -- 방문자 식별 불가 → 보수적으로 집계 제외
    return false;
  end if;
  select count(*) into cnt from public.traffic_pv_seen where date = p_date;
  if cnt >= p_cap then return false; end if;            -- 일자 하드캡(행 폭증 차단)
  select last_seen into prev from public.traffic_pv_seen
    where date = p_date and path = p_path and visitor = p_visitor and is_admin = p_is_admin;
  if prev is not null and prev > now() - make_interval(mins => p_cooldown_min) then
    return false;                                        -- 쿨다운 내 재조회 — 미집계
  end if;
  insert into public.traffic_pv_seen(date, path, visitor, is_admin, last_seen)
  values (p_date, p_path, p_visitor, p_is_admin, now())
  on conflict (date, path, visitor, is_admin) do update set last_seen = now();
  insert into public.traffic_pv(date, hour, path, is_admin, views, updated_at)
  values (p_date, p_hour, p_path, p_is_admin, 1, now())
  on conflict (date, hour, path, is_admin)
  do update set views = traffic_pv.views + 1, updated_at = now();
  return true;
end; $$;

-- ── RPC: UV 증분 + per-day·per-source 하드캡 (+ is_admin 태깅). ──────────────────
create or replace function public.bump_uv(
  p_date date, p_visitor text, p_source text, p_cap int default 200000,
  p_is_admin boolean default false)
returns boolean language plpgsql as $$
declare cnt int; ins int;
begin
  select count(*) into cnt from public.traffic_visitors where date = p_date and source = p_source;
  if cnt >= p_cap then return false; end if;          -- DB 하드캡
  insert into public.traffic_visitors(date, visitor_id, source, is_admin)
  values (p_date, p_visitor, p_source, p_is_admin)
  on conflict do nothing;
  get diagnostics ins = row_count;
  return ins > 0;                                       -- true = 새 UV
end; $$;

-- ── RPC: 클라 UV 증분 + per-IP 캡 (+ is_admin 태깅). ────────────────────────────
create or replace function public.bump_uv_client(
  p_date date, p_ip_bucket text, p_cid text,
  p_per_ip_cap int default 30, p_global_cap int default 200000,
  p_is_admin boolean default false)
returns boolean language plpgsql as $$
declare gcnt int; icnt int; ins int; vid text;
begin
  select count(*) into gcnt from public.traffic_visitors where date = p_date and source = 'client';
  if gcnt >= p_global_cap then return false; end if;                 -- 전역 하드캡
  vid := p_ip_bucket || ':' || p_cid;
  if exists (select 1 from public.traffic_visitors
             where date = p_date and source = 'client' and visitor_id = vid and is_admin = p_is_admin) then
    return false;                                                    -- 기존 방문자 — 새 UV 아님
  end if;
  select count(*) into icnt from public.traffic_visitors
    where date = p_date and source = 'client' and visitor_id like p_ip_bucket || ':%';
  if icnt >= p_per_ip_cap then return false; end if;                 -- per-IP 캡
  insert into public.traffic_visitors(date, visitor_id, source, is_admin)
    values (p_date, vid, 'client', p_is_admin) on conflict do nothing;
  get diagnostics ins = row_count;
  return ins > 0;
end; $$;

-- ── RPC: 대시보드 집계 재정의 — 기존 키는 is_admin=false(실제 외부 트래픽)만, ────
--     관리자 전용 집계 3키(admin_pv / admin_client_uv / admin_server_uv) 신설. ──
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
    'top_referrers', (select coalesce(jsonb_agg(z.r), '[]'::jsonb) from (
                    select jsonb_build_object('referrer', referrer, 'count', count) r
                    from public.traffic_referrers where date between p_from and p_to
                    order by count desc limit 20) z),
    'admin_pv', (select coalesce(sum(views), 0) from public.traffic_pv
                    where is_admin = true and date between p_from and p_to),
    'admin_client_uv', (select count(*) from public.traffic_visitors
                    where is_admin = true and source = 'client' and date between p_from and p_to),
    'admin_server_uv', (select count(*) from public.traffic_visitors
                    where is_admin = true and source = 'server' and date between p_from and p_to)
  );
$$;
