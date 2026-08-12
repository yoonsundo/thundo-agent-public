# LLM 위키 — SCHEMA (이 위키의 규칙과 운영법)

> Karpathy 3계층 중 **스키마 계층**. 이 위키의 디렉토리 구조·작성 규칙·ingest/query/lint
> 워크플로우와 Meerkat 관제탑의 운영 책임을 정의한다. 방법론 일반은 [methodology.md](methodology.md).

## 디렉토리 구조

```
docs/llm-wiki/
  index.md                      # content 카탈로그 (쿼리 시 먼저 읽음)
  log.md                        # append-only 연대기 (ingest/query/lint/propose)
  SCHEMA.md                     # 이 파일 — 구조·규칙·워크플로우
  methodology.md                # Karpathy LLM Wiki 패턴 reference
  concepts/                     # 개념 페이지 (방법론·규칙)
    agent-contract.md
    compliance-rules.md
  entities/                     # 엔티티 페이지 (구체 대상)
    agent-registry.md
```

## 계층 매핑 (본 프로젝트)

| 계층 | 위치 | 가변성 |
|------|------|--------|
| 원문 소스 | `runs/**`, `published/**`, `benchmark/**`, 외부 URL | 불변(읽기만) |
| 위키 | `docs/llm-wiki/**` | LLM 제안 → lion/사람 적용 |
| 스키마 | 이 파일 + 루트 `CLAUDE.md` | 사람 주도 |

## 작성 규칙

- 모든 페이지는 H1 제목 + 1줄 목적 인용으로 시작한다.
- 새 페이지를 만들면 **반드시 index.md에 한 줄 요약과 함께 등재**한다(고아 금지 — lint R로 검출).
- 교차참조는 상대경로 마크다운 링크로 건다.
- 주장에는 가능한 한 출처(파일경로·URL·런 ID)를 붙인다.
- log.md는 **추가만**. 기존 항목 수정·삭제 금지.

## 워크플로우

### Ingest (새 소스 흡수)
1. 원문을 한 번에 하나 읽는다(원문 수정 금지).
2. 핵심을 요약 → 관련 concepts/entities 페이지에 통합(필요 시 신규 페이지).
3. index.md에 신규 페이지 등재.
4. 모순 발견 시 심각도 부여 — **하드 모순은 사람 해소 전까지 차단**.
5. log.md에 `INGEST` 항목 append.

### Query (질의)
1. index.md를 먼저 읽어 관련 페이지 식별.
2. 페이지들을 종합해 **출처와 함께** 답한다.
3. 재사용 가치가 큰 답은 새 페이지로 저장하고 index 갱신.
4. log.md에 `QUERY` 항목 append.

### Lint (주기 점검)
1. `node scripts/meerkat/compliance-audit.mjs --wiki` 실행 → 고아·index/log 누락 검출.
2. `node scripts/meerkat/compliance-audit.mjs` 실행 → 에이전트 방법론 준수 R1~R12 검출.
3. 발견 사항을 **제안**으로 정리해 lion에게 전달(Meerkat은 Write 없음).
4. log.md에 `LINT` 항목 append.

## Meerkat 관제탑의 운영 책임

- 이 위키의 **큐레이터**: ingest/query/lint를 **수행 제안**한다(적용은 lion/사람).
- 방법론 준수 **주기 감사**: 결정론 스크립트(`scripts/meerkat/compliance-audit.mjs`)를 실행하고
  결과를 읽어 위반을 보고한다. 스크립트 결과가 단일 진실 — Meerkat이 점수를 지어내지 않는다.
- **금지**: 위키/에이전트 파일 직접 Write, 감시장치 수정, 자기 자신 준수 자가판정.

## 주기 실행 (periodic)

```bash
npm run meerkat            # 에이전트 방법론 준수 감사 (R1~R12)
npm run meerkat:wiki       # LLM 위키 lint (고아·index/log)
npm run meerkat:all        # 둘 다
npm run test:meerkat       # 감사 도구 자체 회귀 테스트
```

수동(현재): 위 npm 스크립트로 임의 시점 실행한다. **현재 `scripts/run-lion.mjs`는 STEP 0~8까지만 구현**되어
있으며 종료 직후 감사 자동 실행(STEP 9) 배선은 **아직 없다**(2026-06-26 실측 — log.md LINT 참조). 추가 주기는
cron/CI 또는 run-lion.mjs STEP 9 신설로 확장 가능(advisory·발행 비차단 권장). 자동 배선은 사람 승인 후 적용한다.
