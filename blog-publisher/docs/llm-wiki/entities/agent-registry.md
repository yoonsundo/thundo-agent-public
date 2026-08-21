# 엔티티 — 에이전트 레지스트리 (45)

> 20개 에이전트의 역할·도구·단계·계약 요약. LLM 위키 방법론 "도입 추적"의 기준 페이지
> (준수 규칙 R12). 신규 에이전트는 여기에 등재되어야 위키 도입으로 인정된다.

## 오케스트레이터 · 통신허브

- **lion** (v3) — CEO 오케스트레이터·통신허브. 일일 런 전체 위임·집계·진단·자가치유 총괄 + crane 이상보고 수신·조율. 도구 Task·Read·Bash·Glob·Grep. Write 없음. 단계: 전체. [진화](evolution/lion.md)

## 수집 (1단계)

- **cheetah** (v2) — 트렌드 주제 수집. 도구 Read·Glob·Write. [진화](evolution/cheetah.md)
- **owl** (v2) — 심층·근거 주제 수집. 도구 Read·Glob·Write. [진화](evolution/owl.md)
- **magpie** (v2) — Reddit+HN 주제 수집. 도구 Bash·Read·Write. [진화](evolution/magpie.md)

## 작가 (3단계)

- **beaver** (v5) — how-to 초안 작가(1500~2000 음절). 도구 Read·Write. [진화](evolution/beaver.md)
- **fox** (v5) — 리뷰 초안 작가. 도구 Read·Write. [진화](evolution/fox.md)
- **wolf** (v5) — 오피니언 초안 작가. 도구 Read·Write. [진화](evolution/wolf.md)

## 검증자 (5단계, 차단권만·Write 없음)

- **eagle** (v2) — 사실확인 검증. 도구 Read. [진화](evolution/eagle.md)
- **bee** (v2) — SEO 검증. 도구 Read. [진화](evolution/bee.md)
- **swan** (v2) — 편집·가독성 검증. 도구 Read. [진화](evolution/swan.md)
- **raven** (v2) — 독창성·표절 검증. 도구 Read·Bash. [진화](evolution/raven.md)
- **peacock** (v1) — 렌더·형태·이쁨 검증(홈 HTML 적합성). 결정론 게이트 `check-render-fit` 단독 판정을 보완하는 차단권만. 도구 Read.

## 발행 (6단계)

- **penguin** (v2) — 게이트 통과 초안 발행·git push(force-push 금지). 도구 Read·Write·Bash. [진화](evolution/penguin.md)

## 거버넌스 · 감독 (7단계, Write 없음·제안전용)

- **elephant** (v3) — 거버넌스. EVOLVE-BLOCK 변종 제안·회귀게이트 판정·단조성 감시·crane 감독(Phase 3 OFF). 도구 Read·Bash. [진화](evolution/elephant.md)
- **crane** (v1) — 주치의. 에이전트 건강검진·진단·수리안 제안·3단계 에스컬레이션(Elephant 감독). 도구 Read·Bash·Glob·Grep. [진화](evolution/crane.md)
- **meerkat** (v1) — **관제탑**. LLM 위키 방법론 운영 제안 + 전체 에이전트 방법론 준수 주기 감사(R1~R12). 자기채점 금지. 도구 Read·Bash·Glob·Grep. 단계: 전체(주기). [진화](evolution/meerkat.md)

## 방법론 수집 · 관제 · 정찰 (주기 · 운영)

- **hummingbird** (v1) — SEO/AEO 방법론 수집. 최신 논문·공식문서를 bee 검증 기준 후보(candidate)로 제출(승격 권한 없음). 도구 Read·Write·WebFetch·WebSearch. 단계: 주기(주1회).
- **parrot** (v1) — 관제·보고. 관리 중인 외부 dev 프로젝트를 읽기전용 게이트웨이로 자율 조사해 매 평일 상세 브리핑(Slack·Telegram·Discord). 도구 Bash·Read. 관찰대상 수정 절대금지(SEED:locked).
- **spider** (v1) — 정찰·분석. 승인된 크롤 타겟을 실측 정찰해 즉시 구현 가능한 API 설계 명세 산출(읽기전용 게이트웨이·본인세션·GET 우선·수정 절대금지). 도구 Bash·Read·Write.
- **woodpecker** (v1) — 인프라 관제(infra-observer). 서버·사이트 건강을 읽기전용 게이트웨이(`scripts/infra/infra-gateway.sh` health/services/logs/journal/web)로 점검해 이상 징후를 브리핑(Slack·Telegram·Discord). 도구 Bash·Read. 서버·사이트 수정 절대금지(SEED:locked). [진화](evolution/woodpecker.md)

## 관련

- [../concepts/agent-contract.md](../concepts/agent-contract.md) — 공통 계약
- [../concepts/compliance-rules.md](../concepts/compliance-rules.md) — 준수 규칙

## 신설 팀 (2026-08-21 등재)

> 호기심 쇼츠·카드뉴스·개발팀·팀장 에이전트. 정의는 `.claude/agents/<name>.md`,
> 로스터는 `CLAUDE.md` 의 '에이전트 로스터' 절과 같다.

- **architect** — 설계자 — 데이터모델·렌더링경계·모듈배치 설계 (개발팀) 도구 Read·Write·Glob·Grep.
- **badger** — 호기심채널 팩트체커 — 선정 아이템의 가벼운 사실 안전망(플로시빌리티+기본 출처), 통과분만 제작 (호기심팀 3단계) 도구 Read·Bash.
- **coder** — 코더 — 스펙대로 타입안전 TS/React 구현 (개발팀) 도구 Read·Write·Edit·Bash·Glob·Grep.
- **deer** — 카드뉴스채널 편성자 — 백로그를 공명·저장욕구·명료성으로 채점해 매일 best-pick 1건 선정 (카드뉴스팀 2단계) 도구 Read·Bash.
- **designer** — 디자이너 — Modernist Kit UI 설계·anti-slop (개발팀) 도구 Read·Write·Glob·Grep.
- **devops** — 배포담당 — 마이그레이션 먼저·배포·롤백 (개발팀) 도구 Read·Write·Edit·Bash·Glob·Grep.
- **dolphin** — 유튜브팀장 — CMO(성장·오디언스)·CDO(데이터) 겸직. 쇼츠 채널 성과와 소재 전략을 책임지고 CEO 경영회의에 브리핑 도구 Read·Bash·Glob·Grep.
- **falcon** — 블로그팀장 — CPO(콘텐츠 제품)·CCO(품질) 겸직. 발행 품질·주제 전략을 책임지고 CEO 경영회의에 브리핑 도구 Read·Bash·Glob·Grep.
- **fennec** — 호기심채널 오케스트레이터 — 백로그→선정→검증→JIT제작→큐 일일 조율, 팀 위임·집계 (호기심팀 총괄) 도구 Read·Bash·Glob·Grep.
- **firefly** — 카드뉴스채널 총괄 오케 — 백로그→선정→원문대조→대본→게이트→렌더→발행 일일 조율 (카드뉴스팀 총괄·직접 창작 X) 도구 Read·Bash·Glob·Grep.
- **hedgehog** — 카드뉴스채널 인용 검증 — 원문 대조를 통과한 구절의 맥락 왜곡·출처 정확도만 판정 (카드뉴스팀 3단계·차단권만) 도구 Read·Bash.
- **heron** — 카드뉴스채널 소재 발굴 — 고전문학 구절 + 오늘의 문제를 경량 백로그로 수집 (카드뉴스팀 1단계) 도구 Read·Write·Bash.
- **lynx** — 호기심채널 큐레이터 — 백로그를 반전·호기심 강도로 채점해 매일 best-pick 1건 선정 (호기심팀 2단계) 도구 Read·Bash.
- **mole** — 인사이트·분석 관측(insight-observer) — 내부 조회수(traffic_summary)·GSC 성과를 읽기전용 게이트웨이로 읽어 추세·이상을 브리핑 (읽기전용·수정 절대금지) 도구 Bash·Read.
- **nightingale** — 호기심채널 작가 — 반전 사실 1건을 30~60초 카드 대본(훅·카드·CTA + 카드별 이미지 프롬프트)으로 (호기심팀 4단계) 도구 Read·Write·Bash.
- **orchestrator** — 개발팀 지휘자 — 요청을 9인 팀에 순서대로 위임·집계 (직접 코드 안 씀) (개발팀) 도구 Read·Glob·Grep.
- **panther** — 인스타팀장 — CBO(브랜드)·CLO(저작권·법무) 겸직. 카드뉴스 톤앤매너와 인용 안전을 책임지고 CEO 경영회의에 브리핑 도구 Read·Bash·Glob·Grep.
- **planner** — 기획자 — 요청을 스펙·완료기준으로 분해 (개발팀) 도구 Read·Write·Glob·Grep.
- **raccoon** — 호기심채널 아이디어 발굴 — "설마 진짜?" 반전 사실 후보를 경량 백로그로 수집 (호기심팀 1단계) 도구 Read·Write·Bash.
- **rhino** — 개발팀장 — CTO(플랫폼·신뢰성)·CISO(보안) 겸직. 파이프라인 안정성과 사이트 품질을 책임지고 CEO 경영회의에 브리핑 도구 Read·Bash·Glob·Grep.
- **robin** — 카드뉴스채널 작가 — 검증된 구절 1건을 카드 7장 대본 + 캡션으로 (카드뉴스팀 4단계) 도구 Read·Write·Bash.
- **security-reviewer** — 보안리뷰어 — Supabase 권한·시크릿·XSS·RLS 검토 (차단권) (개발팀) 도구 Read·Bash·Glob·Grep.
- **sheepdog** — 파이프라인 관제·자가복구 — 매일 자동으로 도는 잡·상시프로세스·크리덴셜을 4시간마다 점검하고 안전한 문제는 자동복구, 사람 조치 필요건은 알림 (결정론·파괴적동작 금지) 도구 Bash·Read.
- **tester** — 테스터 — 빌드·E2E(Playwright) 동작 검증 (개발팀) 도구 Read·Write·Bash·Glob·Grep.
- **verifier** — 검증자 — 스펙정합·회귀 최종 게이트 (자가승인 금지) (개발팀) 도구 Read·Bash·Glob·Grep.
