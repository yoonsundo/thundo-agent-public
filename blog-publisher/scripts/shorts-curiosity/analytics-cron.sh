#!/usr/bin/env bash
# analytics-cron.sh — 호기심 쇼츠 채널 성과 수집·학습·브리핑 (WSL cron, 새벽 2시 KST 권장)
#
# 왜 필요한가: analytics-collect.mjs 는 어떤 cron 에도 걸려 있지 않았고, 실패해도 warn+exit 0
# 이라 조용했다 → 업로드 47편의 조회수가 단 한 번도 수집된 적이 없었다.
# 이 래퍼가 매일 체인을 돌리고, 각 단계의 **종료코드를 로그에 보존**한다.
#
# 체인: analytics-collect.mjs → (있으면) evolve.mjs → analytics-report.mjs
#   evolve.mjs 는 별도 작업으로 추가되는 중 — 파일이 없으면 스킵하고 로그에 남긴다(체인 미파손).
#
# ⚠ `cmd || echo "실패"` 로 쓰지 않는다 — 그러면 127(스크립트 부재=미실행)조차 성공처럼 보인다
#   (2026-07-23 교훈). 반드시 rc 를 잡아 로그에 찍고, 최종 exit 는 최악의 rc 를 반영한다.
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/curiosity-analytics-$(date +%F).log"
LOCK="state/shorts-curiosity/analytics.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== curiosity analytics $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"

# flock -n: 앞 회차가 아직 도는 중이면 즉시 종료(중복 수집·중복 알림 방지).
# 체인이 여러 단계라 파일 디스크립터 형태로 락을 잡는다(단일 명령 형태로는 감쌀 수 없음).
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[analytics] 이미 실행 중 — 이번 회차 스킵 $(date -u +%FT%TZ)" >> "$LOG"
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

run_step collect scripts/shorts-curiosity/analytics-collect.mjs

# evolve.mjs 는 다른 작업에서 추가되는 중 — 없으면 스킵(내 체인이 127 로 깨지지 않게).
if [ -f scripts/shorts-curiosity/evolve.mjs ]; then
  run_step evolve scripts/shorts-curiosity/evolve.mjs
else
  echo "--- [evolve] scripts/shorts-curiosity/evolve.mjs 없음 — 스킵 $(date -u +%FT%TZ)" >> "$LOG"
fi

run_step report scripts/shorts-curiosity/analytics-report.mjs

if [ "$worst" -eq 0 ]; then
  echo "[analytics] 체인 정상 종료 $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "[analytics] 체인 종료 — 최악 종료코드 $worst $(date -u +%FT%TZ)" >> "$LOG"
fi
exit "$worst"
