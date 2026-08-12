# 개념 — 벤치마크 앵커 (fitness 기준)

> 자가발전 루프의 회귀 기준점. 게이트 13종 + 검증자 4명을 전수 통과한 양품 편과 의도적으로 실패하는 부정 편을 동결 보존하여, 파이프라인 개선 시 품질 방향이 뒤집히지 않는지 검증한다.
> 출처: `benchmark/**`, `CLAUDE.md` § 벤치마크 · 자가발전 보고서

---

## 양품 앵커(seed)

경로: `benchmark/seed/`

- 문서상 30편 / **실측 33편**
- 선정 기준: 결정론 게이트 13종 전수 통과 + 검증자 4명(Eagle·Bee·Swan·Raven) 전수 통과
- 위상: Phase 3 fitness 앵커 후보로 지정, 이후 인간 감사를 거쳐 **동결(freeze)**
- 역할: 새 게이트나 작가 버전 배포 시 seed 편 전체가 여전히 통과되는지 회귀 검사 기준

## 부정 앵커(negative)

경로: `benchmark/negative/`

- 문서상 5편 / **실측 11편**
- 수록 결함 유형:

  | 유형 | 설명 |
  |------|------|
  | ai-slop | LLM 기계문체 과다 |
  | 인용세탁 | 빈 URL·무출처 기관통계 |
  | 퍼소나 템플릿 | 반복 1인칭 경험 앵커, 구체 증거 없음 |
  | 키워드 스터핑 | 니치 키워드 과밀 삽입 |
  | 번역체 | 영어 직역 문장 구조 |

- 역할: 게이트 강화 후 해당 편이 여전히 FAIL을 내는지 **판별력 회귀 검사** 기준

## 동결 정책

1. **인간 감사 후 동결** — 자동 선정만으로는 seed 지위를 부여하지 않는다. 인간이 최종 확인 후 파일을 `benchmark/seed/`에 커밋하면 그 시점부터 동결된다.
2. **불변성** — 동결 편은 내용 수정 금지. 수정이 필요하면 기존 편을 삭제하고 새 편으로 교체한다(해시 체인 기록 유지).
3. **최소 구성** — seed ≥ 20편, negative ≥ 5편을 유지한다. 미달 시 Elephant가 경고 발령.
4. **자가발전 연동** — `self_evolution.enabled=false`(현재 OFF) 상태에서도 벤치마크 파일 자체는 gate-smoke 대상으로 유지된다.

## self-evolution과의 관계

동결 벤치마크는 Elephant 회귀게이트의 **외부 채점 기준**으로 작동한다 — 어떤 파이프라인 변경도 seed 전원 통과·negative 전원 실패를 깨뜨리면 배포가 차단된다.

참고: 자가발전 이력(에이전트 v1→v5/v2 진화·게이트 신설 과정)은 git 커밋 이력(iter7~30)과 [self-evolution.md](self-evolution.md)·`entities/evolution/`에 기록된다. (`runs/self-improve-report.md`는 CLAUDE.md가 참조하나 현재 워킹트리에 부재 — [log.md](../log.md) LINT 참조.)

---

## 관련

- [self-evolution.md](self-evolution.md)
- [gates.md](gates.md)
