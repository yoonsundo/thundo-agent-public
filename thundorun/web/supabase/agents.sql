-- agents — 에이전트 소개 페이지 프로필 카드 DB (projects.sql 동일 패턴)
-- 사이트는 service_role(서버)로 읽고, 관리자가 /admin/agents 에서 등록/수정/삭제.
-- 적용: blog-publisher 의 node scripts/db/migrate.mjs 또는 Supabase SQL Editor.
create table if not exists public.agents (
  id          text primary key,
  name        text not null,
  role        text not null default '',
  description text not null default '',
  image_url   text,
  emoji       text not null default '🤖',
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agents_sort_idx on public.agents (sort_order asc);

-- RLS: service_role(서버) 전용. 사이트는 서버에서 읽으므로 anon 정책 없음.
alter table public.agents enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_agents_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_agents_updated_at on public.agents;
create trigger trg_agents_updated_at before update on public.agents
  for each row execute function public.touch_agents_updated_at();

-- 초기 시드: 블로그 자동발행 파이프라인 에이전트 16마리 (이미 있으면 무시)
insert into public.agents (id, name, role, description, emoji, sort_order) values
  ('lion',     '라이언 (Lion)',       '오케스트레이터',        '매일 아침 발행 런 전체를 지휘하는 CEO. 수집부터 발행까지 모든 에이전트에게 일을 나눠주고, 문제가 생기면 스스로 복구합니다.', '🦁', 10),
  -- 팀장(C레벨) 4인 — 2026-08-21 신설. 파이프라인을 실행하지 않고 매일 CEO와 경영회의를 연다.
  ('falcon',   '팰컨 (Falcon)',       '블로그팀장 · CPO·CCO',  '높이 떠서 전체를 보는 눈. 블로그팀의 팀장으로 어떤 글을 만들지(CPO)와 그 글이 충분히 좋은지(CCO)를 함께 책임집니다. 매일 아침 CEO에게 발행·검색 성과를 브리핑하고 다음 주 전략을 제안합니다.', '🦅', 11),
  ('dolphin',  '돌핀 (Dolphin)',      '유튜브팀장 · CMO·CDO',  '무리와 신호를 주고받는 사냥꾼. 쇼츠 채널의 팀장으로 어떻게 더 보게 만들지(CMO)와 무엇을 근거로 판단할지(CDO)를 맡습니다. 성과 계측이 끊겨 있으면 그 복구를 가장 먼저 요구합니다.', '🐬', 12),
  ('rhino',    '라이노 (Rhino)',      '개발팀장 · CTO·CISO',   '단단한 가죽의 파수꾼. 파이프라인 신뢰성(CTO)과 보안(CISO)을 함께 봅니다. "돌아가긴 하나요"가 아니라 "조용히 실패하고 있지는 않나요"를 묻습니다.', '🦏', 13),
  ('panther',  '팬서 (Panther)',      '인스타팀장 · CBO·CLO',  '소리 없이 살피는 감각. 카드뉴스 채널의 브랜드 목소리(CBO)와 인용·저작권 안전(CLO)을 책임집니다. 예쁘게 나왔는지보다 그 문장이 정말 그 책에 있는지를 먼저 묻습니다.', '🐆', 14),
  ('cheetah',  '치타 (Cheetah)',      '트렌드 주제 수집',      '가장 빠른 발. AI·자동화 분야의 최신 트렌드를 실시간으로 스캔해 오늘 쓸 만한 주제 후보를 물어옵니다.', '🐆', 20),
  ('owl',      '아울 (Owl)',          '심층 주제 수집',        '밤새 공부하는 학자. 유행보다 깊이 — 근거 자료와 레퍼런스가 탄탄한 주제를 발굴합니다.', '🦉', 30),
  ('magpie',   '맥파이 (Magpie)',     '커뮤니티 소재 수집',    '반짝이는 것을 모으는 수집가. Reddit과 Hacker News 에서 개발자들이 진짜로 이야기하는 소재를 주워옵니다.', '🐦', 40),
  ('beaver',   '비버 (Beaver)',       'how-to 작가',           '성실한 건축가. 단계별 실습 가이드를 차근차근 쌓아 올려 따라 하기 쉬운 글을 짓습니다.', '🦫', 50),
  ('fox',      '폭스 (Fox)',          '리뷰 작가',             '영리한 비교 분석가. AI 도구와 서비스를 직접 뜯어보고 장단점을 솔직하게 저울질합니다.', '🦊', 60),
  ('wolf',     '울프 (Wolf)',         '오피니언 작가',         '무리를 이끄는 목소리. 관점과 주장이 뚜렷한 오피니언 글로 논쟁의 방향을 제시합니다.', '🐺', 70),
  ('eagle',    '이글 (Eagle)',        '사실확인 검증',         '하늘에서 내려다보는 눈. 초안의 주장·수치·출처가 사실과 맞는지 매의 눈으로 검증합니다.', '🦅', 80),
  ('bee',      '비 (Bee)',            'SEO 검증',              '부지런한 일벌. 키워드·구조·메타 정보를 점검해 검색엔진이 좋아하는 글로 다듬어졌는지 확인합니다.', '🐝', 90),
  ('swan',     '스완 (Swan)',         '편집 검증',             '우아한 편집장. 가독성과 문장 흐름, 완성도를 살펴 글이 물 흐르듯 읽히는지 심사합니다.', '🦢', 100),
  ('raven',    '레이븐 (Raven)',      '표절 검증',             '기억력 좋은 감별사. 진부한 표현과 표절 흔적을 찾아내 독창적인 글만 통과시킵니다.', '🐦‍⬛', 110),
  ('peacock',  '피콕 (Peacock)',      '렌더·형태 검증',        '아름다움의 심판. 홈페이지에 올렸을 때 형태가 깨지지 않고 이쁘게 보이는지 최종 점검합니다.', '🦚', 120),
  ('penguin',  '펭귄 (Penguin)',      '발행',                  '믿음직한 배달부. 모든 검증을 통과한 글을 실제 사이트에 안전하게 발행합니다.', '🐧', 130),
  ('elephant', '엘리펀트 (Elephant)', '거버넌스·감사',         '기억을 잃지 않는 감사관. 모든 기록을 감사로그에 남기고 규칙이 무너지지 않게 감시합니다.', '🐘', 140),
  ('crane',    '크레인 (Crane)',      '건강검진·자가치유',     '팀 주치의. 일하는 에이전트들의 이상을 진단하고 수리안을 제안해 파이프라인을 건강하게 유지합니다.', '🕊️', 150),
  ('meerkat',  '미어캣 (Meerkat)',    '관제탑·방법론 감사',    '망루 위의 파수꾼. 팀이 정한 방법론을 잘 지키는지 주기적으로 살피고 개선을 제안합니다.', '🦦', 160),
  ('hummingbird', '허밍버드 (Hummingbird)', 'SEO·AEO 방법론 수집', '쉼 없이 나는 탐구자. SEO·AEO 최신 논문과 공식 문서를 모아 비(Bee)의 검증 기준 후보로 제출합니다 (승격 권한은 없이 제안만).', '🐤', 170),
  ('parrot',   '패럿 (Parrot)',       '관제·일일 브리핑',      '성실한 관찰자. 관리 중인 외부 개발 프로젝트를 읽기 전용으로 살펴보고, 매일 상세한 브리핑으로 소식을 전합니다.', '🦜', 180),
  ('spider',   '스파이더 (Spider)',   '정찰·분석',             '치밀한 정찰가. 승인된 크롤 타겟의 실제 네트워크 동작을 관찰해, 바로 구현할 수 있는 API 설계 명세를 그려냅니다 (읽기 전용·수정 금지).', '🕷️', 190)
on conflict (id) do nothing;

-- 개발팀 9인 — 홈페이지(thundo.kr) 기능 추가·신메뉴 개설을 전담하는 파이프라인 팀 (이미 있으면 무시)
insert into public.agents (id, name, role, description, emoji, sort_order) values
  ('dev-orchestrator', '지휘자 (Orchestrator)', '개발팀 팀장',   '홈페이지 기능·신메뉴 요청을 받아 9인 개발팀에 순서대로 일을 나눠주고 결과를 모으는 팀장입니다.', '🎯', 200),
  ('dev-planner',      '기획자 (Planner)',      '스펙·기획',     '요청을 명확한 스펙과 완료 기준으로 쪼갭니다. 모호하면 추측하지 않고 먼저 되묻습니다.', '📋', 210),
  ('dev-architect',    '설계자 (Architect)',    '구조·데이터모델', 'UI를 그리기 전에 데이터 모델·렌더링 경계·모듈 배치를 정하는 밑그림 담당입니다.', '🏛️', 220),
  ('dev-designer',     '디자이너 (Designer)',   'UI/UX 설계',    'Radix·Tailwind로 화면을 설계하고, "AI 티" 나는 밋밋한 디자인을 걸러냅니다.', '🎨', 230),
  ('dev-coder',        '코더 (Coder)',          '구현',          '스펙 그대로 — 그 이상도 이하도 아니게 타입 안전한 코드를 구현합니다.', '⌨️', 240),
  ('dev-tester',       '테스터 (Tester)',       '동작 검증',     '빌드와 실제 브라우저 동작(E2E)을 확인하고, 페어와이즈로 테스트 케이스를 설계합니다.', '🧪', 250),
  ('dev-security',     '보안리뷰어 (Security)', '보안 검토',     'Supabase 권한·키 노출·XSS 등 보안 결함을 잡는 문지기입니다 (심각도 무관 차단권).', '🔒', 260),
  ('dev-verifier',     '검증자 (Verifier)',     '최종 품질 게이트', '스펙 전 항목 충족과 회귀 여부를 증거로 최종 확인합니다. 작성자와 검증자는 반드시 분리됩니다.', '✅', 270),
  ('dev-devops',       '배포담당 (DevOps)',     '배포·롤백',     '마이그레이션 먼저→배포 순서를 지키고, 문제가 생기면 롤백하는 배포 담당입니다.', '🚀', 280)
on conflict (id) do nothing;

-- 호기심 쇼츠 팀 6인 — 독립 "설마 진짜?" 유튜브 쇼츠 채널을 전담하는 팀 (이미 있으면 무시)
insert into public.agents (id, name, role, description, emoji, sort_order) values
  ('raccoon',     '라쿤 (Raccoon)',           '호기심 아이디어 발굴',   '호기심 쇼츠 채널의 아이디어 발굴자. "설마 진짜?" 반전 사실을 실제 인기 데이터(Reddit 등)에서 길어와 백로그에 쌓습니다.', '🦝', 290),
  ('lynx',        '링스 (Lynx)',              '호기심 큐레이터',       '날카로운 눈의 선별가. 백로그를 반전·호기심·개인 몰입도로 채점해 매일 만들 best-pick 한 편을 고릅니다.', '🐈‍⬛', 300),
  ('badger',      '배저 (Badger)',            '팩트체크 안전망',       '끈질긴 검증가. 제작 전 가벼운 사실 확인으로 의심스러운 소재를 걸러냅니다 (차단권만).', '🦡', 310),
  ('nightingale', '나이팅게일 (Nightingale)', '쇼츠 대본 작가',        '채널의 이야기꾼. 검증된 반전 사실을 첫 3초에 호기심이 터지는 구어체 카드 대본과 배경 아트 프롬프트로 만듭니다.', '🎙️', 320),
  ('fennec',      '페넥 (Fennec)',            '호기심 채널 오케스트레이터', '큰 귀로 팀을 조율하는 총괄. 백로그→선정→검증→제작→발행 흐름을 매일 지휘합니다 (직접 창작은 안 함).', '🦊', 330),
  ('mole',        '몰 (Mole)',                '인사이트 관측',         '땅속을 살피는 분석가. 내부 조회수·검색 성과를 읽기 전용으로 관측해 추세와 이상을 브리핑합니다 (수정 금지).', '🐭', 340)
on conflict (id) do nothing;

-- 카드뉴스 팀 5인 — 인스타그램 "고전문학의 문장으로 건네는 위로" 채널을 전담하는 팀 (이미 있으면 무시)
insert into public.agents (id, name, role, description, emoji, sort_order) values
  ('heron',    '헤론 (Heron)',           '카드뉴스 소재 발굴',    '물가에 오래 서서 한 문장만 건져 올리는 새. 오늘 누군가 겪고 있을 문제와, 저작권이 만료된 고전문학에서 그 문제를 실제로 다룬 구절을 짝지어 옵니다.', '🪶', 350),
  ('deer',     '디어 (Deer)',            '카드뉴스 편성',         '작은 소리 하나에 멈춰 서는 짐승. 소재 후보를 공명·저장 욕구·명료성으로 채점해 그날 만들 한 편을 고릅니다.', '🦌', 360),
  ('hedgehog', '헤지호그 (Hedgehog)',    '인용 검증',             '확신이 없으면 웅크리는 검증자. 원문 대조를 통과한 구절이 원래 맥락과 어긋나지 않는지, 출처와 번역이 정확한지 살핍니다 (차단권만).', '🦔', 370),
  ('robin',    '로빈 (Robin)',           '카드뉴스 작가',         '겨울에도 노래하는 새. 검증된 구절 한 편을 카드 7장과 캡션으로 옮깁니다 — 인용은 한 글자도 바꾸지 않고, 해설은 오늘의 말로.', '🐦', 380),
  ('firefly',  '파이어플라이 (Firefly)', '카드뉴스 오케스트레이터', '어둠 속에서 길만 밝히는 불빛. 소재 발굴→선정→인용 검증→대본→렌더→발행까지 하루치 흐름을 조율합니다 (직접 창작은 안 함).', '✨', 390)
on conflict (id) do nothing;

-- 관제 3인 — 사이트·인프라·파이프라인을 밖에서 지켜보는 팀 (이미 있으면 무시)
-- ⚠ 이 셋은 시드에 빠져 있었는데 **실 DB에는 이미 있었다**(2026-08-21 화면에서 구스가 발견됨).
--    시드가 실 DB보다 오래됐던 것이라 파일을 현실에 맞춘다. on conflict do nothing 이라
--    라이브 값을 덮어쓰지 않는다.
insert into public.agents (id, name, role, description, emoji, sort_order) values
  ('goose',      '구스 (Goose)',           '사이트 관제',   '블로그 사이트(thundo.kr)의 건강을 매일 바깥에서 점검하는 사이트 관제 담당입니다. 홈·블로그·사이트맵의 응답과 속도를 실측해 이상 징후를 브리핑하며, 사이트를 직접 고치지는 않습니다.', '🪿', 400),
  ('woodpecker', '우드페커 (Woodpecker)',  '인프라 관제',   '두드려서 속을 아는 새. 관찰 대상 서버의 상태·서비스·로그를 읽기전용으로 훑어 이상 징후만 골라 브리핑합니다 (재시작·배포·수정은 하지 않습니다).', '🐦', 410),
  ('sheepdog',   '시프도그 (Sheepdog)',    '파이프라인 관제', '무리를 세지 않고 지키는 개. 매일 도는 잡·상시 프로세스·크리덴셜을 주기적으로 점검해 안전하게 되돌릴 수 있는 문제는 스스로 복구하고, 사람 손이 필요한 건만 알립니다 (파괴적 동작 금지).', '🐕', 420)
on conflict (id) do nothing;

-- ── 마스코트 초상 배선 (2026-08-21) ──────────────────────────────────────────
-- 아바타의 단일 출처는 **DB의 image_url** 이다. 화면(소개 카드·홈 미리보기·흐름도·관리자·
-- 대화)은 전부 이 값을 읽으므로, 관리자에서 바꾸면 모든 곳이 함께 바뀐다.
-- 파일은 web/public/agent-portraits/<id>.jpg (208x208). 출처·매핑 근거는 같은 폴더 _source.json.
--
-- ⚠ `on conflict do nothing` 이 아니라 **update** 다. 위 insert 들은 신규 행만 만들고,
--    이미 있는 행에는 image_url 이 비어 있기 때문이다(그래서 화면에 첫 글자 아바타가 떴다).
-- ⚠ 이미 다른 이미지를 지정해 둔 행은 건드리지 않는다(`where image_url is null or = ''`).
--    관리자가 개별 교체한 값을 시드 재실행이 덮으면 안 된다.
update public.agents
   set image_url = '/agent-portraits/' || id || '.jpg',
       updated_at = now()
 where (image_url is null or image_url = '')
   and id in (
     'lion','falcon','dolphin','rhino','panther','cheetah','owl','magpie','beaver','fox',
     'wolf','eagle','bee','swan','raven','peacock','penguin','elephant','crane','meerkat',
     'hummingbird','parrot','spider','raccoon','lynx','badger','nightingale','fennec','mole',
     'heron','deer','hedgehog','robin','firefly','goose','woodpecker','sheepdog',
     'dev-orchestrator','dev-planner','dev-architect','dev-designer','dev-coder',
     'dev-tester','dev-security','dev-verifier','dev-devops'
   );
