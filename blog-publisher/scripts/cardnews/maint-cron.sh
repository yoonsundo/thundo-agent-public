#!/usr/bin/env bash
# maint-cron.sh — 카드뉴스 채널 일일 유지보수 (WSL cron, 새벽 02:10 KST 권장)
#
# 체인: 성과 수집(insights) → 검토큐 자동만료(review-expire) → 리포트(비차단)
#
# 왜 이 파일이 있는가 — 두 기능 다 "만들어졌지만 아무도 부르지 않는" 상태였다.
#
#  ① **성과 수집**: 이 채널의 성공 지표 1순위가 저장(save)인데, 인스타 인사이트는 소급 조회
#     창이 좁다. 발행 첫날부터 안 돌면 그 기간 데이터는 **영구 소실**이고, "저장이 안 나온다"는
#     말은 할 수 있어도 "어느 카드에서 이탈했는지"는 영영 모른다. 호기심 채널이 정확히 이걸로
#     당했다 — analytics-collect 가 어떤 cron 에도 안 걸려 있어서 업로드 47편의 조회수가
#     **단 한 번도** 수집되지 않았다(analytics-cron.sh 헤더 참조).
#
#  ② **검토큐 만료**: TIER-2 경고는 발행을 막지 않고 큐에 쌓인다. 자동 만료가 안 돌면 큐가
#     무한정 커진다(사용자 결정 2026-07-31 — 자동만료 + 월간요약, 적체로 인한 자동정지는 끔).
#
# ⚠ `cmd || echo "실패"` 로 쓰지 않는다 — 127(파일 부재 = 미실행)조차 성공처럼 보인다
#   (2026-07-23 교훈). rc 를 잡아 로그에 찍고 최종 exit 는 최악의 rc 를 반영한다.
#
# 발행과 무관하다 — 이 체인은 아무것도 게시하지 않는다. 크리덴셜이 없으면 각 단계가
# warn + exit 0 으로 빠지므로, 계정 설정 전에 걸어둬도 안전하다.
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/cardnews-maint-$(date +%F).log"
LOCK="state/cardnews/maint.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== cardnews maint $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"

# flock -n: 앞 회차가 도는 중이면 즉시 종료(중복 수집 방지). 체인이 여러 단계라 fd 형태로 잡는다.
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[maint] 이미 실행 중 — 이번 회차 스킵 $(date -u +%FT%TZ)" >> "$LOG"
  exit 0
fi

worst=0

run_step() {
  local label="$1"; shift
  echo "--- [$label] 시작 $(date -u +%FT%TZ)" >> "$LOG"
  # --env-file=.env: 스크립트는 .env 를 스스로 읽지 않는다(GSC·네이버 SEO 와 동일 계약).
  node --env-file=.env "$@" >> "$LOG" 2>&1
  local rc=$?
  echo "--- [$label] 종료코드 $rc $(date -u +%FT%TZ)" >> "$LOG"
  if [ "$rc" -ne 0 ] && [ "$rc" -gt "$worst" ]; then worst=$rc; fi
  return "$rc"
}

# ① 성과 수집 — 발행된 글의 저장·공유·도달. 토큰 없으면 warn+exit 0.
run_step insights scripts/cardnews/insights.mjs

# ② 검토큐 자동만료 — auto_expire_days 지난 미검토 TIER-2 를 auto_reviewed 로 내린다.
run_step review-expire scripts/cardnews/gate-generalization.mjs --expire

# ③ 리포트 — 카나리아. days_covered 가 안 늘면 ①이 조용히 멈춘 것이다.
run_step report scripts/cardnews/report.mjs --insights

if [ "$worst" -eq 0 ]; then
  echo "[maint] 체인 정상 종료 $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "[maint] 체인 종료 — 최악 종료코드 $worst $(date -u +%FT%TZ)" >> "$LOG"
fi
exit "$worst"
