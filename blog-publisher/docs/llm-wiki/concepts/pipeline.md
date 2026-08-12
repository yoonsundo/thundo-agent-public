# 개념 — 일일 런 파이프라인 단계

> Lion 오케스트레이터(`scripts/run-lion.mjs`)가 매일 실행하는 STEP 0~8 직렬·병렬 혼합 파이프라인.
> 권위 출처: `scripts/run-lion.mjs` (§D2 알고리즘 구현), `CLAUDE.md` "파이프라인 단계" 블록.

## STEP 개요

| 단계 | 책임 | 담당 에이전트 | 산출 / 부수효과 |
|------|------|--------------|----------------|
| STEP 0 | lock 획득 → killswitch 확인 → 예산 사전체크 | Lion (watchdog 모듈) | `runs/<date>/` 디렉터리 생성, 중복 실행 차단, 예산 초과 시 즉시 abort |
| STEP 1 | 주제 후보 수집 (병렬) | Cheetah (트렌드), Owl (깊이), Magpie (Reddit RSS + HN Algolia) | 후보 주제 배열 병합, budget charge(tokens 3000, calls 3) |
| STEP 2 | 주제 3선정 — dedup_key 중복 회피 + seed backfill | Lion | `state/topic-history.jsonl` append (fate=selected), 부족 시 `seed-topics.md` 백필 |
| STEP 3 | 작가 배정 + 초안 생성 + 파일 기록 (병렬) | Beaver (how-to), Fox (리뷰), Wolf (오피니언) | `runs/<date>/drafts/*.draft.md` 기록, budget charge(tokens 6000, calls N) |
| STEP 4 | 결정론 게이트 13종 (LLM 앞 선행) | `scripts/gates/run-all-gates.mjs` (자식 프로세스) | gate JSON 결과(all_pass bool), FAIL 시 LLM 스킵·retry 또는 폐기 |
| STEP 5 | 검증자 4명 병렬 — 사실·SEO·편집·표절 | Eagle (사실확인), Bee (SEO), Swan (편집), Raven (표절) | `publishable = gate.all_pass AND 4명 무차단`, budget charge(tokens 4000, calls 4) |
| STEP 6 | 발행 / 재시도(retry≤2) / 폐기 | Penguin (발행), Lion (재시도 루프 조율) | `published/<date>-<slug>.md` 기록, live 모드: git commit, `state/published-index.json` 갱신 |
| STEP 7 | 감사로그 append + 알림 | Elephant (감사로그), Lion (notify) | `.omc/audit/audit-log.jsonl` append(sha256 해시체인), Telegram·Discord 알림 전송 |
| STEP 8 | 런 요약 기록 + lock 해제 | Lion | `runs/<date>/run.json` 기록, lock 파일 해제 (finally 블록 — abort 경로에서도 항상 실행) |

## 흐름 설명

### STEP 0 — 선제 보호막

세 검사가 순차로 실행된다. lock 획득 실패(중복 PID) → killswitch 활성 → 예산 초과 중 하나라도 해당되면 즉시 abort하고 알림을 보낸다. 이후 단계에서 발생하는 모든 예산 초과도 각 STEP 직후에 동일하게 abort를 트리거한다.

### STEP 1~2 — 수집·선정

Cheetah·Owl은 mock 데이터(`mockResearch`)를 반환하고, Magpie는 Reddit RSS Atom 피드와 HN Algolia API를 실수집한다(`COLLECT_LIVE=1`). 세 결과를 병합한 뒤 `published-index.json`의 `dedup_key`와 대조해 중복을 제거하고 최대 3건을 선정한다. 후보가 부족하면 `seed-topics.md`에서 백필한다.

### STEP 3 — 작가 순환 배정

`WRITER_ROTATION = ['beaver', 'fox', 'wolf']`를 인덱스 모듈 연산으로 순환 배정한다. 각 작가는 병렬(`Promise.all`)로 초안을 생성하고 `runs/<date>/drafts/` 아래에 파일로 저장한다.

### 수집-작가 근거전달·협업 설계 (구독 실행 — daily-runbook.md)

구독 기반 실행(`scripts/daily-runbook.md`, 실 서브에이전트)에서는 mock 이 아니라 다음이 강제된다:
- 수집팀(cheetah/owl/magpie)은 단순 주제 나열이 아닌 **실제 근거(출처·통계·레퍼런스)**를 담은 `runs/<date>/topics/pool.json` 을 **협업 산출**한다 (magpie 실수집 → cheetah 트렌드 각도 → owl 심층 근거).
- 작가(beaver/fox/wolf)는 이 풀의 `sources` 를 `source_refs` 로 인용해 글을 쓴다 — **근거 없는 주제 창작 금지**. 빈 sources 로 작성하면 게이트(credibility/sources)에서 FAIL.
- 각 작가는 배정 시 **다른 두 작가의 주제**를 컨텍스트로 받아 중복 각도를 회피한다(3작가 협업). 하루 최대 3편(작가당 1편).

### STEP 4~6 — 품질 루프 (retry≤2)

게이트 → 검증 → 발행의 3단계가 초안마다 while 루프로 반복된다. 게이트 FAIL은 LLM 호출을 건너뛰어 예산을 절약한다. 검증 미통과나 발행 오류도 `retry_limit`(기본 2) 이내에서 재시도하고, 초과하면 폐기(`fate=discarded`)로 기록한다.

### STEP 7~8 — 마무리 (finally 보장)

STEP 8은 `try/finally` 블록 안에 있어 abort·오류 경로에서도 런 요약과 lock 해제가 항상 실행된다. STEP 7의 감사로그는 sha256 해시체인으로 append-only가 보장되며 Elephant가 무결성을 감시한다.

## 실행

```bash
# mock 모드 — 크리덴셜 불필요, 수집도 캔드 데이터
RUN_MODE=mock node scripts/run-lion.mjs
npm run pipeline

# 실수집 + mock 파이프라인 — Reddit RSS + HN 실제 수집, LLM·발행은 mock
COLLECT_LIVE=1 RUN_MODE=mock node scripts/run-lion.mjs
npm run pipeline:collect

# npm 단축키
npm run collect        # 실수집 검증 스크립트 (collect.mjs)
npm run smoke          # 스모크 테스트 (smoke.mjs, 현재 16종) 검증
npm run audit:verify   # 감사체인 무결성 검증
npm run gate <file>    # 결정론 게이트 13종 일괄 실행
```

## 상태 코드

런 완료 후 `runs/<date>/run.json`의 `status` 필드:

| 값 | 의미 |
|----|------|
| `success` | 1건 이상 발행 성공 |
| `zero_published` | 모든 초안이 게이트/검증 실패로 폐기 |
| `budget_preempt` | 예산 캡 도달로 중간 abort |
| `aborted` | killswitch 활성 또는 lock 획득 실패 |

## 관련

- [gates.md](gates.md) — 결정론 게이트 13종 상세
- [collection-sources.md](collection-sources.md) — Reddit RSS·HN Algolia 수집 소스
- [../entities/agent-registry.md](../entities/agent-registry.md) — 전체 에이전트 역할·버전 일람
