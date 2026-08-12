# LLM 위키 — log (append-only 연대기)

> Karpathy LLM Wiki 패턴의 **append-only 로그**. ingest/query/lint 활동을 시간순으로 누적한다.
> 접두어로 단순 파싱: `INGEST` · `QUERY` · `LINT` · `PROPOSE`.
> 규칙: **수정·삭제 금지, 추가만**. 항목은 ISO8601 날짜로 시작한다.

---

- `2026-06-26` INGEST — Karpathy LLM Wiki 패턴 출처 3종 흡수 → methodology.md 생성.
  출처: Karpathy gist(442a6bf), news.hada.io/topic?id=28208, wikidocs book/19830(LLM위키 완벽 가이드).
- `2026-06-26` INGEST — 기존 14개 에이전트 계약 구조 흡수 → concepts/agent-contract.md, entities/agent-registry.md 생성.
- `2026-06-26` INGEST — 방법론 준수 규칙 R1~R12 정의 → concepts/compliance-rules.md 생성.
- `2026-06-26` PROPOSE — 15번째 에이전트 Meerkat(관제탑) 신설. 역할: LLM 위키 운영 제안 + 방법론 준수 주기 감사. read-only·제안전용·자기채점 금지.
- `2026-06-26` LINT — compliance-audit 최초 실행: 15개 에이전트 전수 준수 확인(critical 0, major 0). 위키 lint orphan 0.
- `2026-06-26` INGEST — Meerkat 감사를 lion 일일 런 STEP 9에 자동 배선(`scripts/run-lion.mjs`, advisory·발행 비차단). 수동 실행 의존 제거 → "주기적" 점검 자동화 완료.
- `2026-06-26` INGEST — 자가발전 메커니즘 흡수 → concepts/self-evolution.md 생성(EVOLVE-BLOCK·elephant 회귀게이트·외부 프로세스 적용·단조성·현재 OFF). 출처: `config/pipeline.json`, `.claude/agents/elephant.md`, 각 에이전트 SEED/EVOLVE 마커.
- `2026-06-26` INGEST — 에이전트별 진화 연표 15편 생성 → entities/evolution/{에이전트}.md + evolution/index.md. git 이력(iter7~30·crane/meerkat 도입)으로 버전 복원. 각 `.claude/agents/*.md`에 상대경로 포인터 1줄 추가(심볼릭 링크 비권장 — meerkat 조언). index 등재 완료(고아 0).
- `2026-06-26` LINT — agent-registry 버전 정정: lion v2→v3(crane 에스컬레이션 수신), elephant v2→v3(crane 감독 §E5). 파일 실측값과 동기화.
- `2026-06-26` INGEST — meerkat 전수 검사(compliance-audit --all) 기반 LLM 위키 방법론 전수 적용. 도메인 지식 4종 위키화 → concepts/{pipeline,gates,collection-sources,benchmark-anchors}.md, 향후 컨벤션 → concepts/agent-onboarding.md. 5종 모두 index.md 등재(고아 0).
- `2026-06-26` INGEST — 직전 세션 유실분 복구: `.claude/agents/*.md` 14개 진화 이력 포인터 재적용(EVOLVE-BLOCK 바깥, 15/15), `CLAUDE.md` Meerkat 행 추가·lion/elephant v2→v3·14마리→15마리, `package.json` meerkat/meerkat:wiki/meerkat:all/guard/test:meerkat 스크립트 등록(+description 13→15).
- `2026-06-26` LINT — **하드 모순 표면화(사람 해소 필요)**: ① SCHEMA.md·log.md(line15)가 주장한 "STEP 9 meerkat 자동감사 배선"이 `scripts/run-lion.mjs` 실측 STEP 0~8에 **부재** → SCHEMA.md 코드-진실로 정정, run-lion.mjs 재배선은 사람 승인 대기. ② 벤치마크 실측 seed 33·negative 11 vs CLAUDE.md 문서 30·5 드리프트 → benchmark-anchors.md에 "문서상/실측" 병기, 동결셋 정합은 사람 판단 대기.
- `2026-06-26` LINT — topology-setup.md를 index.md 방법론 섹션에 교차참조 등재(위키 외부 문서, meerkat guard 감사 대상 L1~L4).
- `2026-06-26` INGEST — 사업 확장 딥리서치 → concepts/business-expansion-research.md 생성. 출처: Lion 주도 웹리서치(nevermined·saasmag·gartner via lovelytics 등). 백링크 4종 검증·index 등재(meerkat 검수).
- `2026-06-27` INGEST — 에이전트 일일 업무보고(육하원칙) 방법론 → concepts/agent-reporting.md. 생성기 scripts/report/daily-brief.mjs, 아카이브 docs/work-history/(index 연결). Meerkat 검수.
- `2026-06-27` LINT — pipeline.md에 "수집-작가 근거전달·3작가 협업" 설계 반영(Meerkat 제안). daily-runbook.md·CLAUDE.md 정합 확인. pool.json 실생성 다음 런 검증.
