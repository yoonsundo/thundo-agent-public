#!/usr/bin/env bash
# seo-weekly-cron.sh — 주간 SEO 측정·제안 체인 (WSL cron, 일요일 11:30 KST)
#
# 왜 필요한가: `cohort-report.mjs`(적용 전/후 성과 비교)와 `internal-links.mjs`(내부링크 추천)는
# CLAUDE.md 상 SEO 폐루프의 일부로 적혀 있었지만 **어떤 cron·npm 스크립트에도 배선돼 있지 않았다.**
# 그 결과 cohort 리포트는 2026-07-02 수동 실행 1건이 전부였고, 내부링크 추천은 2026-07-07 에
# 한 번 돌린 뒤(state/internal-links/ 에 그 시점 스냅샷이 커밋돼 있다) 갱신이 멈춰 있었다.
# 일일 체인(daily-claude-cron.sh 09:07)은 수집·피드백·적용까지만 담당하고, 주간 단위로만
# 의미가 생기는 이 둘을 여기서 돌린다.
#
# 체인: cohort-report(적용 전/후 코호트 비교) → internal-links(내부링크 추천, SUGGESTION-ONLY)
#   둘 다 읽기·산출물 생성만 한다 — 발행물이나 config 를 고치지 않는다.
#
# ⚠ `cmd || echo "실패"` 로 쓰지 않는다 — 그러면 127(스크립트 부재=미실행)조차 성공처럼 보인다
#   (2026-07-23 교훈). rc 를 잡아 로그에 찍고 최종 exit 는 최악의 rc 를 반영한다.
# ⚠ 스크립트는 .env 를 스스로 읽지 않는다 → `node --env-file=.env` 로 주입한다(GSC 계약 동일).
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/seo-weekly-$(date +%F).log"
LOCK="state/seo-weekly.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== seo weekly $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"

# flock -n: 앞 회차가 아직 도는 중이면 즉시 종료(중복 산출 방지).
# 체인이 여러 단계라 파일 디스크립터 형태로 락을 잡는다.
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[seo-weekly] 이미 실행 중 — 이번 회차 스킵 $(date -u +%FT%TZ)" >> "$LOG"
  exit 0
fi

worst=0

run_step() {
  local label="$1"; shift
  echo "--- [$label] 시작 $(date -u +%FT%TZ)" >> "$LOG"
  node --env-file=.env "$@" >> "$LOG" 2>&1
  local rc=$?
  echo "--- [$label] 종료코드 $rc $(date -u +%FT%TZ)" >> "$LOG"
  if [ "$rc" -gt "$worst" ]; then worst=$rc; fi
  return "$rc"
}

# 검색수요 측정이 먼저 — candidates 를 갱신해 두면 다음날 아침 daily 의 apply-targeting 이 소비한다.
run_step keyword-demand scripts/seo/keyword-demand.mjs
run_step cohort scripts/seo/cohort-report.mjs
run_step internal-links scripts/seo/internal-links.mjs

# 회복 계측(2026-09-07 신설) — 8월 스팸 업데이트 대응의 판정 지표.
# 🔴 스팸 조치 회복은 **노출 총량보다 "몇 편이 검색에 잡히는가"에서 먼저 보인다.**
#    그 지표를 지금까지 아무도 모으지 않았다. 기존 산출물(seo-metrics·naver-rank·run.json)만
#    읽는 읽기전용 리포트라 비용이 없고, 실패해도 다른 단계를 막지 않는다(worst 로만 집계).
# ⚠ 만들어 놓고 안 부르면 없는 것과 같다 — 이 저장소가 반복해서 당한 패턴이라 여기 배선한다.
# 색인 상태 수집 — URL Inspection API(속성당 하루 2000 · 분당 600 쿼터). 발행물 203편이라
# 한 스윕이 하루 한도의 10% 다. 크리덴셜이 없거나 부분 실패해도 exit 0(비차단) 계약이고,
# 조회 못 한 URL 은 "색인 안 됨"이 아니라 미조회로 남는다.
# 리포트보다 **앞**에 둔다 — 같은 회차에서 갱신된 색인 상태를 리포트가 읽어야 하기 때문이다.
run_step index-inspect scripts/seo/index-inspect.mjs

run_step recovery scripts/seo/recovery-report.mjs

# 커밋하지 않는다 — 이 저장소는 여러 세션이 동시에 `git add -A` 를 돌려서, 백그라운드 cron 이
# 스테이징에 끼어들면 남의 미커밋 작업이 함께 커밋된다(2026-07-30 실증). 측정 스크립트가
# 감수할 위험이 아니다.
#
# 그 결과 산출물 영속화는 **절반만** 자동이다:
#   state/internal-links/   → daily·weekly-aeo 의 `git add state/` 에 잡혀 커밋된다
#   docs/reports/seo/*.md   → 어떤 체인도 스테이징하지 않아 로컬에만 남는다
# 리포트는 재생성 가능한 파생물이라 그대로 둔다. 보존이 필요하면 daily-claude-cron.sh 의
# `git add` 에 `docs/reports/seo/` 를 추가할 것(naver-rank 리포트도 같은 처지다).

if [ "$worst" -eq 0 ]; then
  echo "[seo-weekly] 체인 정상 종료 $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "[seo-weekly] 체인 종료 — 최악 종료코드 $worst $(date -u +%FT%TZ)" >> "$LOG"
  # rc 를 로그에만 남기면 절반짜리다 — cron 은 `>/dev/null` 이고 runs/*.log 는 gitignore 라
  # 아무도 안 본다. 이 래퍼가 고치려던 문제(무음 실패)를 스스로 재생산하지 않게 알림을 쏜다.
  node scripts/notify/cron-step-fail.mjs seo-weekly "$worst" "$(tail -5 "$LOG")" >> "$LOG" 2>&1 || true
fi
exit "$worst"
