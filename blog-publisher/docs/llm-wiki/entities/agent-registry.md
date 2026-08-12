# 엔티티 — 에이전트 레지스트리 (20)

> 20개 에이전트의 역할·도구·단계·계약 요약. LLM 위키 방법론 "도입 추적"의 기준 페이지
> (준수 규칙 R12). 신규 에이전트는 여기에 등재되어야 위키 도입으로 인정된다.

## 오케스트레이터 · 통신허브

- **lion** (v3) — CEO 오케스트레이터·통신허브. 일일 런 전체 위임·집계·진단·자가치유 총괄 + crane 이상보고 수신·조율. 도구 Task·Read·Bash·Glob·Grep. Write 없음. 단계: 전체. [진화](evolution/lion.md)

## 수집 (1단계)

- **cheetah** (v2) — 트렌드 주제 수집. 도구 Read·Glob·Write.
- **owl** (v2) — 심층·근거 주제 수집. 도구 Read·Glob·Write.
- **magpie** (v2) — Reddit+HN 주제 수집. 도구 Bash·Read·Write.

## 작가 (3단계)

- **beaver** (v5) — how-to 초안 작가(1500~2000 음절). 도구 Read·Write.
- **fox** (v5) — 리뷰 초안 작가. 도구 Read·Write.
- **wolf** (v5) — 오피니언 초안 작가. 도구 Read·Write.

## 검증자 (5단계, 차단권만·Write 없음)

- **eagle** (v2) — 사실확인 검증. 도구 Read.
- **bee** (v2) — SEO 검증. 도구 Read.
- **swan** (v2) — 편집·가독성 검증. 도구 Read.
- **raven** (v2) — 독창성·표절 검증. 도구 Read·Bash.
- **peacock** (v1) — 렌더·형태·이쁨 검증(홈 HTML 적합성). 결정론 게이트 `check-render-fit` 단독 판정을 보완하는 차단권만. 도구 Read.

## 발행 (6단계)

- **penguin** (v2) — 게이트 통과 초안 발행·git push(force-push 금지). 도구 Read·Write·Bash.

## 거버넌스 · 감독 (7단계, Write 없음·제안전용)

- **elephant** (v3) — 거버넌스. EVOLVE-BLOCK 변종 제안·회귀게이트 판정·단조성 감시·crane 감독(Phase 3 OFF). 도구 Read·Bash. [진화](evolution/elephant.md)
- **crane** (v1) — 주치의. 에이전트 건강검진·진단·수리안 제안·3단계 에스컬레이션(Elephant 감독). 도구 Read·Bash·Glob·Grep.
- **meerkat** (v1) — **관제탑**. LLM 위키 방법론 운영 제안 + 전체 에이전트 방법론 준수 주기 감사(R1~R12). 자기채점 금지. 도구 Read·Bash·Glob·Grep. 단계: 전체(주기).

## 방법론 수집 · 관제 · 정찰 (주기 · 운영)

- **hummingbird** (v1) — SEO/AEO 방법론 수집. 최신 논문·공식문서를 bee 검증 기준 후보(candidate)로 제출(승격 권한 없음). 도구 Read·Write·WebFetch·WebSearch. 단계: 주기(주1회).
- **parrot** (v1) — 관제·보고. 관리 중인 외부 dev 프로젝트를 읽기전용 게이트웨이로 자율 조사해 매 평일 상세 브리핑(Slack·Telegram·Discord). 도구 Bash·Read. 관찰대상 수정 절대금지(SEED:locked).
- **spider** (v1) — 정찰·분석. 승인된 크롤 타겟을 실측 정찰해 즉시 구현 가능한 API 설계 명세 산출(읽기전용 게이트웨이·본인세션·GET 우선·수정 절대금지). 도구 Bash·Read·Write.
- **woodpecker** (v1) — 인프라 관제(infra-observer). 서버·사이트 건강을 읽기전용 게이트웨이(`scripts/infra/infra-gateway.sh` health/services/logs/journal/web)로 점검해 이상 징후를 브리핑(Slack·Telegram·Discord). 도구 Bash·Read. 서버·사이트 수정 절대금지(SEED:locked).

## 관련

- [../concepts/agent-contract.md](../concepts/agent-contract.md) — 공통 계약
- [../concepts/compliance-rules.md](../concepts/compliance-rules.md) — 준수 규칙
