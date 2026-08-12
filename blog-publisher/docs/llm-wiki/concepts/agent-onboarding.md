# 개념 — 에이전트·문서 온보딩 컨벤션

> 신규 에이전트 추가·기존 에이전트 진화·위키 페이지 문서화 시 따라야 할 절차와 체크리스트의
> **단일 출처**. 이 문서가 정의하는 순서와 규칙을 위반하면 Meerkat 감사(R1~R12)와 위키 lint에서
> 검출된다. 권위 출처: [compliance-rules.md](compliance-rules.md), [self-evolution.md](self-evolution.md),
> [../SCHEMA.md](../SCHEMA.md).

---

## 1. 신규 에이전트 추가 체크리스트

아래 7단계를 **순서대로** 완료해야 한다. 각 단계에 위반 시 걸리는 규칙을 명시한다.

### 1단계 — `.claude/agents/<name>.md` 작성

frontmatter 4개 필드를 모두 작성한다.

```markdown
---
name: <name>          # 파일명과 반드시 일치
description: <역할 한 줄>
tools: <쉼표구분 목록>
model: <모델ID>
---
```

본문에 반드시 포함해야 할 마커·섹션:

| 항목 | 필수 내용 | 위반 시 규칙 |
|------|----------|-------------|
| `<!-- SEED:locked -->` ~ `<!-- /SEED:locked -->` | "발행 가부는 결정론 게이트가 단독 결정" 불변 문구, 권한상승(wsl.exe·service_role) 금지 명시 | R3(critical), R4(critical) |
| `<!-- EVOLVE-BLOCK:start version=1 -->` ~ `<!-- EVOLVE-BLOCK:end -->` | 역할·입력 계약·출력 계약·금지·자가발전 경계 포함 | R5(critical), R6(major), R7(major), R8(major), R9(major) |
| frontmatter `name` == 파일명 | 정확히 일치 | R2(critical) |
| 감독 역할(lion·crane·elephant·meerkat)인 경우 | tools에 Write 없음 | R10(critical) |

참고 구조: `.claude/agents/meerkat.md` (version=1 예시).

### 2단계 — `EVOLVE-BLOCK:end` 바깥에 진화 이력 포인터 추가

EVOLVE-BLOCK 닫는 태그 **아래**에 아래 한 줄을 추가한다.

```markdown
## 진화 이력
버전별 EVOLVE-BLOCK 변경 연표는 본문에 인라인하지 않고 분리 관리한다 → [docs/llm-wiki/entities/evolution/<name>.md](../../docs/llm-wiki/entities/evolution/<name>.md). 메커니즘: [docs/llm-wiki/concepts/self-evolution.md](../../docs/llm-wiki/concepts/self-evolution.md).
```

인라인 이력을 EVOLVE-BLOCK 안에 누적하면 진화 대상인 프롬프트 가독성이 저하되므로 분리가 원칙이다
(근거: [self-evolution.md — 왜 진화 이력을 별도 파일로 분리하는가](self-evolution.md)).

### 3단계 — 진화 연표 페이지 생성 + index 등재

**`docs/llm-wiki/entities/evolution/<name>.md`** 를 신규 생성한다. 최소 내용:

```markdown
# 에이전트 <name> — 버전 연표

> <name> 에이전트의 EVOLVE-BLOCK 채택 이력. append-only — 과거 행 수정 금지.

| 버전 | 날짜 | 변경 요약 | 채택 근거 |
|------|------|----------|----------|
| v1   | YYYY-MM-DD | 최초 도입 | 신규 에이전트 온보딩 |
```

그 후 `docs/llm-wiki/entities/evolution/index.md` 에 해당 에이전트 행을 추가한다.
누락 시 위키 lint(고아 탐지)에서 검출된다(SCHEMA.md — 새 페이지는 반드시 index.md 등재).

### 4단계 — 루트 `CLAUDE.md` 에이전트 표에 행 추가 (R11)

루트 `CLAUDE.md` 상단의 에이전트 표에 새 에이전트 행을 추가하고, 상단 '**N마리**' 카운트를 갱신한다.

```
| <name> | <역할 한 줄> | v1 | <단계> |
```

누락 시: **R11(major)** — 조직도 일관성 위반, meerkat 감사에서 `compliant=false`.

### 5단계 — `docs/llm-wiki/entities/agent-registry.md` 등재 (R12)

agent-registry.md에 에이전트 행(이름·버전·역할·tools·도입일)을 추가한다.

누락 시: **R12(minor)** — 위키 도입 추적 미비, 경고(준수 판정·exit에는 비반영).

### 6단계 — `docs/llm-wiki/index.md` 카탈로그 등재

신규 페이지(연표·기타)가 있으면 `docs/llm-wiki/index.md` 에 한 줄 요약과 함께 등재한다.
고아 페이지는 `npm run meerkat:wiki` lint에서 검출된다(SCHEMA.md — 고아 금지).

### 7단계 — 검증 통과 확인

```bash
npm run meerkat:all   # R1~R12 + 위키 lint — 고아 0, critical/major 위반 0 확인
```

exit 0이 나와야 온보딩 완료다. exit 1이면 위반 목록을 확인해 해당 단계를 재수행한다.

---

## 2. 에이전트 진화 시 갱신 절차

에이전트 진화(EVOLVE-BLOCK 버전 증가)는 **현재 `self_evolution.enabled=false`(Phase 3 OFF)** 이므로
사람 또는 lion이 주도하며, elephant 회귀게이트는 Phase 3 ON 후에만 적용된다
(근거: [self-evolution.md — 현재 상태: OFF](self-evolution.md)).

### EVOLVE-BLOCK 갱신 규칙

- `<!-- EVOLVE-BLOCK:start version=N -->` 의 N을 **채택된 변경분에만** 증가시킨다. 제안·검토 중에는 증가 금지.
- `<!-- SEED:locked -->`·frontmatter(`name`·`tools`·`model`) 는 **절대 불변**. 진화 대상이 아니다.
- SEED 내 "발행 가부는 결정론 게이트가 단독 결정" 문구, 권한상승 금지 명시도 변경 금지(R3·R4).

### 버전 채택 시 동기화 항목

| 항목 | 갱신 내용 | 금지 |
|------|----------|------|
| `docs/llm-wiki/entities/evolution/<name>.md` | 신규 행 **append** (날짜·버전·변경 요약·채택 근거) | 과거 행 수정·삭제 금지 (append-only) |
| `docs/llm-wiki/entities/agent-registry.md` | 버전 컬럼 동기화 | stale 상태 유지 금지 |
| 루트 `CLAUDE.md` 에이전트 표 | 버전 컬럼 동기화 | stale 상태 유지 금지 |

agent-registry.md나 CLAUDE.md 표 버전이 실제 EVOLVE-BLOCK version과 다르면 R11·R12 계열 감사에서
경고 또는 위반으로 검출될 수 있다.

### Phase 3 ON 후 자율 진화 사이클 요약

제안(elephant) → 채점(외부 채점기) → 적용(외부 프로세스) 의 3권 분립.
elephant는 제안·판정만 하며 점수를 자체 산출하거나 파일을 직접 수정하지 않는다
(상세: [self-evolution.md — Phase 3 ON 시 1회 진화 사이클](self-evolution.md)).

---

## 3. 위키 페이지 추가·문서화 컨벤션

SCHEMA.md가 정의하는 작성 규칙을 반드시 따른다(근거: [../SCHEMA.md](../SCHEMA.md)).

### 페이지 구조 필수 요소

```markdown
# <계층> — <제목>        ← H1 제목 (첫 줄)

> <1줄 목적 인용>        ← 둘째 줄, 블록인용

(본문)
```

H1 + 1줄 목적 인용이 없으면 페이지 구조 규칙 위반이다.

### 고아 방지 — 반드시 index 등재

새 페이지를 만들면 **반드시** `docs/llm-wiki/index.md` 에 한 줄 요약과 함께 등재한다.
등재 누락 시 `npm run meerkat:wiki` lint R로 고아 탐지.

### 교차참조

교차참조는 **상대경로 마크다운 링크**로 건다. 절대경로·심볼릭 링크 비권장
(근거: self-evolution.md — "심볼릭 링크 비권장, WSL·Git·컨텍스트 자동로딩 미포함").

```markdown
# 같은 디렉토리
[compliance-rules.md](compliance-rules.md)

# 부모 디렉토리
[../SCHEMA.md](../SCHEMA.md)

# 하위 디렉토리
[../entities/agent-registry.md](../entities/agent-registry.md)
```

### 출처 부착

주장에는 가능한 한 출처(파일경로·URL·런 ID)를 붙인다. 근거 없는 주장은 위키 품질 저하의
원인이며, Meerkat ingest 시 모순 탐지 대상이 된다.

### log.md — append-only

`docs/llm-wiki/log.md` 는 추가만 가능하다. 기존 항목 수정·삭제 금지.
항목 접두어: `INGEST` / `QUERY` / `LINT` / `PROPOSE`.

---

## 4. 검증 명령

| 명령 | 목적 |
|------|------|
| `npm run meerkat:all` | 에이전트 R1~R12 준수 감사 + 위키 lint (고아·index/log 누락) 동시 실행 |
| `npm run meerkat` | 에이전트 방법론 준수 감사만 (R1~R12) |
| `npm run meerkat:wiki` | 위키 lint만 (고아·index/log) |
| `npm run guard` | 가드 무결성 검사 (L1 deny 존재·L2 hook 해시 일치·hooksPath 검증) |
| `npm run test:meerkat` | 감사 도구 자체 회귀 테스트 |

온보딩 완료 기준: `npm run meerkat:all` exit 0, critical/major 위반 0건, 고아 0건.

---

## 관련

- [compliance-rules.md](compliance-rules.md) — R1~R12 규칙 정의 단일 출처
- [self-evolution.md](self-evolution.md) — SEED/EVOLVE-BLOCK 구조·진화 포인터 규칙
- [../SCHEMA.md](../SCHEMA.md) — 위키 작성 규칙·워크플로우·Meerkat 운영 책임
- [../entities/agent-registry.md](../entities/agent-registry.md) — 현재 에이전트 버전·역할 레지스트리
- [../entities/evolution/index.md](../entities/evolution/index.md) — 에이전트별 버전 연표
