# 개념 — 에이전트 일일 업무보고(육하원칙) 방법론

> 매일 각 에이전트가 "누가·언제·어디서·무엇을·왜·어떻게(5W1H)"로 보고하고, 그 히스토리를
> 문서로 누적·연결하는 구조. 권위 출처: `scripts/report/daily-brief.mjs`(생성기)·
> `docs/work-history/`(아카이브). 방법론 감사: Meerkat 주기 감사([[compliance-rules]] 준수).

## 한 줄
모든 발행/검증/진화/이미지 활동을 **에이전트별 5W1H 행**으로 환산해 매일 자동 보고서를 만들고,
`docs/work-history/<날짜>.md` 로 영속화한 뒤 index 로 연결한다. CEO는 한 문서로 전 부서 활동을 본다.

## 5W1H 표준 (각 활동 한 행)
| 필드 | 의미 | 예 |
|------|------|----|
| 누가 | 에이전트명 | beaver / penguin / elephant |
| 언제 | ISO 시각·날짜 | 2026-06-27 |
| 어디서 | 파이프라인 STEP + 산출 경로 | STEP3 작가 → runs/.../draft.md / blog_posts DB |
| 무엇을 | 액션 | 초안 작성 / 발행 / 진화 판정 / 커버 생성 |
| 왜 | 사유 | 주제: X / 게이트 결과 / fitness 점수 |
| 어떻게 | 방법·결과 | 1815음절·게이트14 통과 / DB upsert·이미지 3장 / 기각(단조성) |

## 데이터 소스 (생성기가 재구성)
- **발행물** `published/<날짜>-*.md` → 작가·발행·디자이너 행 (라이브 DB `blog_posts` 슬러그로 필터해 테스트 잔여 배제)
- **감사로그** `.omc/audit/audit-log.jsonl` → actor별 액션 집계
- **진화이력** `state/evolve-history.jsonl` → elephant 판정 행
- **cron 로그** `runs/cron-<날짜>.log` → 자율가동 여부
- (간접) 검증팀(eagle/bee/swan/raven/peacock) = 결정론 게이트14 판정으로 환산

## 생성·연결 흐름
```
매일 cron (daily-claude-cron.sh) 끝 →
  node scripts/report/daily-brief.mjs →
    docs/work-history/<날짜>.md 생성 (부서별 5W1H 표) +
    docs/work-history/index.md 최신순 연결 +
    git 커밋백
```
- 결정론 스크립트라 **에이전트 실행 성패와 무관하게 매일 보장**.
- 수동 생성: `node scripts/report/daily-brief.mjs [YYYY-MM-DD]`.

## 부서 매핑
오케스트레이션(lion) · 수집(cheetah/owl/magpie) · 작가(beaver/fox/wolf) ·
검증(eagle/bee/swan/raven/peacock) · 발행(penguin) · 디자인(designer 듀얼) ·
거버넌스(elephant/crane/meerkat). 미가동 부서는 "대기·간접가동"으로 명시.

## 한계·향후
- 검증팀은 결정론 게이트라 개별 로그가 없어 "게이트14 전수판정"으로 환산(개선: 게이트별 actor 로그 추가).
- 수집팀은 정규 cron에서만 직접 활동(수동런은 작가가 주제 선정).
- 향후: agent-activity.jsonl 로 각 STEP이 5W1H를 직접 기록하면 재구성 정확도↑.

## 관련
- [[pipeline]] — STEP별 책임·에이전트 매핑
- [[self-evolution]] — elephant 진화 판정(보고의 거버넌스 행 소스)
- [[compliance-rules]] — Meerkat 감사 규칙
- 아카이브: `docs/work-history/index.md`
