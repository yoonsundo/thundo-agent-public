# 개념 — 방법론 준수 규칙 R1~R12 (단일 출처)

> Meerkat의 결정론 감사 스크립트 `scripts/meerkat/compliance-audit.mjs`가 강제하는 규칙의
> **단일 출처**. 각 에이전트가 [agent-contract.md](agent-contract.md)와 LLM 위키 방법론을
> "잘 지키는지·잘 도입되었는지"를 기계적으로 점검한다. 규칙 변경 시 이 문서와 스크립트를 함께 갱신.

## 심각도

- **critical** — 계약 근간 위반. 1건이라도 있으면 해당 에이전트 비준수(`compliant=false`).
- **major** — 계약 섹션 누락. 1건이라도 있으면 비준수.
- **minor** — 위키 도입 미비. 경고만(준수 판정·exit에 비반영).

`exit 0` = critical+major 위반 0건. `exit 1` = 위반 1건 이상. `exit 2` = 실행 오류.

## 규칙표

| ID | 점검 | 심각도 | 근거 |
|----|------|--------|------|
| R1 | frontmatter에 name·description·tools·model 모두 존재 | critical | 계약 식별·권한 경계의 기반 |
| R2 | frontmatter `name` == 파일명 | critical | 위임 라우팅 무결성 |
| R3 | SEED:locked 블록 + 불변 문구("발행 가부는 결정론 게이트가 단독 결정") 포함 | critical | 게이트 단독결정권 보장 |
| R4 | SEED 내 권한상승 금지(wsl.exe·service_role) 명시 | critical | 권한 상승·우회 차단 |
| R5 | EVOLVE-BLOCK start/end 균형(≥1, 동수) | critical | 진화영역 경계 무결성 |
| R6 | "입력 계약" 섹션 존재 | major | 위임 컨텍스트 명세 |
| R7 | "출력 계약" 섹션 존재 | major | 반환 스키마·자기보고 금지 명세 |
| R8 | "## 금지" 섹션 존재 | major | 금지 행위 명세 |
| R9 | "자가발전 경계" 섹션 존재 | major | 가변/불변 경계 명세 |
| R10 | 감독 역할(lion·crane·elephant·meerkat)은 tools에 Write 없음 | critical | 감시장치 자가수정 차단 |
| R11 | 루트 CLAUDE.md 에이전트 표에 등재 | major | 조직도 일관성(교차참조) |
| R12 | LLM 위키 agent-registry.md에 등재 | minor | 방법론(위키) 도입 추적 |

## 점수

`score = 통과 규칙 수 / 12`. critical/major 0건이면 `compliant=true`.

## 자기채점 금지

Meerkat 자신의 준수도 이 **스크립트가** 판정한다(Meerkat LLM이 아님). Meerkat은 결과를 읽어
보고만 하며, 자기 자신에 대해 유리한 판정을 생성하지 않는다 — crane/elephant의 자기보고 금지와 동일.

## 관련

- [agent-contract.md](agent-contract.md) — 규칙이 검사하는 계약 정의
- [../SCHEMA.md](../SCHEMA.md) — lint 워크플로우에서 이 규칙을 호출하는 방법
