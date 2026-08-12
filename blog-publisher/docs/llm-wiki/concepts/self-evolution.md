# 개념 — 에이전트 자가발전(self-evolution) 메커니즘

> 에이전트가 "자가발전"하면 실제로 무엇이 일어나고 **소스 수정이 어떻게/어디까지** 이루어지는지를
> 정의한다. 권위 출처는 `config/pipeline.json`·`.claude/agents/elephant.md`·각 에이전트 `.md`의
> `SEED:locked`/`EVOLVE-BLOCK` 마커. 에이전트별 버전 연표는 [../entities/evolution/index.md](../entities/evolution/index.md).

## 한 줄 답

자가발전은 **각 에이전트 `.md`의 `EVOLVE-BLOCK` 영역 텍스트만**, **동결 벤치마크 회귀게이트를
통과했을 때**, **에이전트가 접근할 수 없는 외부 프로세스가** 다시 쓰는 것이다. 소스 수정은 **일어난다.
단, 영역·조건·실행 주체가 엄격히 제한된다.** `SEED:locked`·frontmatter·감시장치 코드는 **절대 불변**.

## 현재 상태: ON (2026-07 기준)

```json
// config/pipeline.json
"self_evolution": { "enabled": true, "adopt_margin": 1.02,
  "note": "ON — 자동학습 가동. 3권분립(제안 elephant↔채점 scorer↔적용 apply-evolve) + 단조성 회귀게이트" }
```

`self_evolution.enabled=true`로 **자동학습 루프가 가동 중**이다. 구현은 `scripts/evolve/` 4종:
`evolve-cycle.mjs`(사이클 오케스트레이션) · `scorer.mjs`(외부 채점) · `apply-evolve.mjs`(외부 적용+가드)
· `log-gate-feedback.mjs`(약점 축적 → `state/evolve-feedback.jsonl`). 현재 진화 대상은
작가 3종(beaver/fox/wolf)의 요일 로테이션이며, 채택 이력은 `state/evolve-history.jsonl`에 append된다.
끄려면 `enabled: false` — elephant는 로드 즉시 플래그를 확인하고 OFF면
`{"actor":"elephant","status":"disabled","reason":"self_evolution.enabled=false"}` 한 줄만 반환 후 종료한다.

초기 진화(작가 v1→v5 등, [버전 연표](../entities/evolution/index.md))는 **자가발전 루프가 아니라
사람이 주도한 토너먼트형 self-improve 30 iteration**의 결과다. 현행 자율 루프의 채택분과 구분해야 한다.

## 에이전트 `.md`의 2영역

각 에이전트 정의 파일은 두 영역으로 나뉜다.

```
<!-- SEED:locked -->        ← 영구 불변. 자가수정 영구 금지.
  ...불변 계약...
<!-- /SEED:locked -->

<!-- EVOLVE-BLOCK:start version=N baseline_ref=state/benchmark-baseline.json -->
  ...진화 가능한 역할·휴리스틱·프롬프트...
<!-- EVOLVE-BLOCK:end -->
```

| 영역 | 가변성 | 내용 |
|------|--------|------|
| frontmatter (`name`·`tools`·`model`) | **영구 불변** | 정체성·권한 |
| `SEED:locked` | **영구 불변** | 산출물=데이터·게이트 단독결정·권한상승 금지 등 핵심 계약 |
| `EVOLVE-BLOCK` | Phase 3에서 가변 | 역할 서술·입출력 계약·휴리스틱·프롬프트 |

`version=N`은 EVOLVE-BLOCK이 채택(adopt)될 때마다 증가한다. 이것이 "자가발전 이력"의 단위다.

## Phase 3 ON 시 1회 진화 사이클

```
1. (트리거)   정기(매일) 또는 이벤트(게이트 실패율 급등) — 대상 에이전트 1개만
2. (제안)     elephant가 대상의 EVOLVE-BLOCK 변종을 제안. 자기 영역 내 텍스트만,
              다른 에이전트 영역·감시장치 침범 금지.
3. (채점)     외부 채점기가 동결 벤치마크(state/benchmark-baseline.json)로 A/B 독립 실행.
              elephant는 점수를 산출하지 않는다(자기보고 금지) — 외부 결과만 수신.
4. (판정)     elephant 회귀게이트:
                adopt   ← 종합점수 ≥ baseline +2% AND 모든 차원 무회귀
                reject  ← 위 미달 (단조성 위반·근거 부재 포함)
                rollback← 트립와이어(점수위조·게이트우회·자기평가루프) 탐지
5. (적용)     ★ elephant가 접근 불가한 외부 프로세스가 실제 파일 수정·롤백을 수행.
              elephant는 제안·판정만. → 보상해킹(스스로 채점·스스로 적용) 구조적 차단.
6. (기록)     version=N+1, 감사로그 append, 진화 이력 페이지 갱신.
```

핵심 분리: **제안(elephant) ↔ 채점(외부 채점기) ↔ 적용(외부 프로세스)** 의 3권 분립.
한 주체가 채점·판정·적용을 겸할 수 없다.

## 소스 수정의 경계 (무엇이 절대 안 되는가)

elephant 단조성 강제(§E5)에 의해, 아래를 **약화·우회**하는 변종은 내용 무관 무조건 reject:

- `SEED:locked`·frontmatter 변경
- 감시장치 코드 수정: `scripts/gates/**`·`scripts/watchdog/**`·`scripts/audit/**`·`seeds/**`
- 게이트 임계 완화(예: `max_jaccard`↑, 음절 하한↓), 금지어 항목 감소
- 검증자 authority 다운그레이드(차단권 약화)
- crane(medic)이 감시장치 약화 수리안을 **제안만 해도** 차단
- 동일 에이전트 3일 연속 adopt → 외부 감사 요청 트립와이어

즉 자가발전은 **품질을 올리는 방향(게이트 첫시도 통과율↑·재시도↓)으로만 단조 증가**하며,
방어선을 내리는 변경은 구조적으로 불가능하다.

## 왜 진화 이력을 별도 파일로 분리하는가

각 에이전트 `.md`에 버전별 변경 로그를 인라인하면 EVOLVE-BLOCK이 비대해지고, 정작 진화 대상인
프롬프트 가독성이 떨어진다. 그래서 이력은 [entities/evolution/](../entities/evolution/index.md)로 분리하고,
각 에이전트 본문에는 **상대경로 마크다운 링크 한 줄**만 둔다(심볼릭 링크 비권장 — meerkat 조언,
WSL·Git·컨텍스트 자동로딩 미포함 문제). 위키 방법론의 "복리 축적 + index 등재 + 교차참조" 원칙.

## 관련

- [agent-contract.md](agent-contract.md) — SEED·EVOLVE·입출력 계약 공통 방법론
- [compliance-rules.md](compliance-rules.md) — 준수 규칙 R1~R12
- [../entities/evolution/index.md](../entities/evolution/index.md) — 에이전트별 버전 연표(15)
- [../entities/agent-registry.md](../entities/agent-registry.md) — 현재 버전·역할 레지스트리
- 출처: `.claude/agents/elephant.md`(거버넌스 권위), `config/pipeline.json`(OFF 플래그)
