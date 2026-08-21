# LLM 위키 — index (먼저 읽는 카탈로그)

> Karpathy LLM Wiki 패턴의 **content-oriented 카탈로그**. 모든 위키 페이지를 한 줄 요약과 함께
> 카테고리별로 나열한다. 쿼리(질문) 시 이 파일을 **가장 먼저** 읽는다.
> 유지보수: Meerkat이 변경을 **제안**하고 lion(또는 사람)이 적용한다 — Meerkat은 Write 없음.

## 스키마 · 운영

- [SCHEMA.md](SCHEMA.md) — 이 위키의 3계층 구조·규칙·ingest/query/lint 워크플로우·Meerkat 역할
- [log.md](log.md) — append-only 연대기 로그 (ingest/query/lint 기록)

## 방법론 (reference)

- [methodology.md](methodology.md) — Karpathy LLM Wiki 패턴 원문 정리 (RAG와의 차이·3계층·핵심 작업·출처)
- [../topology-setup.md](../topology-setup.md) — 신뢰 도메인 토폴로지 L1~L4 가드 스택 (위키 외부 문서, meerkat guard 감사 대상)

## 개념 (concepts)

- [concepts/agent-contract.md](concepts/agent-contract.md) — 에이전트 계약 방법론(SEED·EVOLVE·입력/출력 계약·금지·자가발전 경계)
- [concepts/compliance-rules.md](concepts/compliance-rules.md) — 방법론 준수 규칙 R1~R12 (Meerkat 감사의 단일 출처)
- [concepts/self-evolution.md](concepts/self-evolution.md) — 자가발전 메커니즘: 무엇이/어디까지 소스 수정되나(EVOLVE-BLOCK·회귀게이트·외부 적용·단조성·현재 OFF)
- [concepts/agent-onboarding.md](concepts/agent-onboarding.md) — **향후 컨벤션**: 신규 에이전트 추가·진화·위키 문서화 체크리스트(R11/R12 위반 예방)
- [concepts/business-expansion-research.md](concepts/business-expansion-research.md) — 사업 확장 딥리서치 노트(시장데이터·틀강점·B2B/거버넌스SaaS/버티컬 3안)
- [concepts/agent-reporting.md](concepts/agent-reporting.md) — 에이전트 일일 업무보고(육하원칙) 방법론·생성기·work-history 아카이브 연결

### 도메인 지식 (concepts) — 파이프라인 운영 지식 위키화

- [concepts/pipeline.md](concepts/pipeline.md) — 일일 런 파이프라인 STEP별 책임·에이전트 매핑·실행 명령
- [concepts/gates.md](concepts/gates.md) — 결정론 품질 게이트 13종 판정기준·임계·exit 계약·scripts/gates 매핑
- [concepts/collection-sources.md](concepts/collection-sources.md) — 주제 수집 소스(Reddit RSS·HN Algolia·COLLECT_LIVE·제약)
- [concepts/benchmark-anchors.md](concepts/benchmark-anchors.md) — 벤치마크 앵커(seed·negative·동결 정책·fitness 기준)

## 엔티티 (entities)

- [entities/agent-registry.md](entities/agent-registry.md) — 45개 에이전트 레지스트리(역할·도구·단계·계약 요약)
- [entities/evolution/index.md](entities/evolution/index.md) — 에이전트별 진화(버전) 연표 카탈로그(16) — agent.md 본문 비대화 없이 분리 관리

### 진화 연표 (entities/evolution) — agent.md가 포인터로 참조

- [entities/evolution/lion.md](entities/evolution/lion.md) — lion 진화(v3)
- [entities/evolution/cheetah.md](entities/evolution/cheetah.md) — cheetah 진화(v2)
- [entities/evolution/owl.md](entities/evolution/owl.md) — owl 진화(v2)
- [entities/evolution/magpie.md](entities/evolution/magpie.md) — magpie 진화(v2)
- [entities/evolution/beaver.md](entities/evolution/beaver.md) — beaver 진화(v5)
- [entities/evolution/fox.md](entities/evolution/fox.md) — fox 진화(v5)
- [entities/evolution/wolf.md](entities/evolution/wolf.md) — wolf 진화(v5)
- [entities/evolution/eagle.md](entities/evolution/eagle.md) — eagle 진화(v2)
- [entities/evolution/bee.md](entities/evolution/bee.md) — bee 진화(v2)
- [entities/evolution/swan.md](entities/evolution/swan.md) — swan 진화(v2)
- [entities/evolution/raven.md](entities/evolution/raven.md) — raven 진화(v2)
- [entities/evolution/penguin.md](entities/evolution/penguin.md) — penguin 진화(v2)
- [entities/evolution/elephant.md](entities/evolution/elephant.md) — elephant 진화(v3)
- [entities/evolution/crane.md](entities/evolution/crane.md) — crane 진화(v1)
- [entities/evolution/meerkat.md](entities/evolution/meerkat.md) — meerkat 진화(v1)
- [entities/evolution/woodpecker.md](entities/evolution/woodpecker.md) — woodpecker 진화(v1)

## 빠른 참조

| 알고 싶은 것 | 보는 곳 |
|--------------|---------|
| LLM 위키가 무엇이고 왜 쓰나 | methodology.md |
| 위키를 어떻게 운영/갱신하나 | SCHEMA.md |
| 에이전트가 지켜야 할 구조 계약 | concepts/agent-contract.md |
| 준수 감사 규칙·심각도 | concepts/compliance-rules.md |
| 특정 에이전트의 역할·계약 | entities/agent-registry.md |
| 자가발전 시 소스가 수정되나 | concepts/self-evolution.md |
| 특정 에이전트의 버전 변천사 | entities/evolution/{에이전트}.md |
| 새 에이전트/문서 추가 절차 | concepts/agent-onboarding.md |
| 파이프라인 단계·게이트·수집 소스 | concepts/pipeline.md · gates.md · collection-sources.md |
| 벤치마크 앵커·fitness 기준 | concepts/benchmark-anchors.md |
| 최근 무슨 변경이 있었나 | log.md |
