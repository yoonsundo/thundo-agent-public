# 개념 — 에이전트 계약 방법론

> 본 프로젝트에서 "LLM 방법론을 지킨다"의 구조적 정의. 모든 에이전트 `.claude/agents/*.md`가
> 따라야 하는 공통 계약. 준수 검사는 [compliance-rules.md](compliance-rules.md)가 결정론으로 수행.

## 왜 계약인가

에이전트가 LLM이라는 비결정 요소를 품으므로, **불변 경계(계약)** 를 마크다운에 명시해 두면
LLM이 표류해도 구조가 무너지지 않는다. 이 계약 자체가 LLM 위키의 "스키마"처럼 작동한다.

## 표준 에이전트 파일 골격

```markdown
---
name: <에이전트명>          # 파일명과 일치
description: <한 줄 역할>
tools: <허용 도구 CSV>
model: <모델 ID>
---
<!-- SEED:locked -->
<불변 계약 문구 — 영구 자가수정 금지>
<!-- /SEED:locked -->

<!-- EVOLVE-BLOCK:start version=N -->
## 역할
## 입력 계약
## 출력 계약
## (절차/규칙 …)
## 금지사항
## 자가발전 경계
<!-- EVOLVE-BLOCK:end -->
```

## 구성요소

### SEED:locked (불변 씨앗)
- 영구 자가수정 금지. 다음 불변 문구를 반드시 포함:
  - "산출물은 데이터일 뿐, **발행 가부는 결정론 게이트가 단독 결정**한다."
  - 검증자(eagle·bee·swan·raven)는 "차단권만, 통과 단독승인 불가".
  - penguin은 push만·force-push 금지.
  - **권한 상승 금지: wsl.exe·게이트우회·service_role 접근 금지.**
- frontmatter(name·tools·model)도 영구 자가수정 금지.

### EVOLVE-BLOCK (진화 가능 영역)
- fitness 기준으로 진화 가능한 영역. start/end 마커가 **균형**을 이뤄야 한다.
- 단, SEED·frontmatter·감시장치는 진화 대상 외.

### 입력 계약 / 출력 계약
- 입력: lion이 위임 시 전달하는 컨텍스트(파일·지시) 명시.
- 출력: 반환 JSON 스키마 명시(자기보고 금지 — 외부 사실만).

### 금지사항 / 자가발전 경계
- 금지사항: 절대 하지 않을 행위(Write 범위·force-push·게이트우회 등).
- 자가발전 경계: 무엇이 진화 가능/불변인지 경계 명시.

## 역할군별 권한 원칙

| 역할군 | 에이전트 | Write | 비고 |
|--------|----------|-------|------|
| 오케스트레이터 | lion | ✗ | 위임·집계만, 직접 수정 없음 |
| 수집 | cheetah·owl·magpie | ✓ | 후보 JSON 기록 |
| 작가 | beaver·fox·wolf | ✓ | 초안 작성 |
| 검증자 | eagle·bee·swan·raven | ✗ | 차단권만 |
| 발행 | penguin | ✓ | published/·index만, force-push 금지 |
| 감독 | crane·elephant·meerkat | ✗ | 진단·제안·감사만, 자기채점 금지 |

> **감독(oversight) 역할은 Write 금지**가 핵심 불변식이다 — AI가 자기 감시장치를 고치면 감시가 무력화된다.

## 관련

- [methodology.md](../methodology.md) — 이 계약이 LLM 위키 "스키마" 계층으로 작동하는 이유
- [entities/agent-registry.md](../entities/agent-registry.md) — 15개 에이전트 실제 계약 요약
