#!/usr/bin/env bash
# curiosity-kickstart-cron.sh — 오늘(2026-07-14) 18:00 KST 일회성 킥스타트.
# 신전략 3편은 이미 즉시 업로드됨 → 18:00 에 새 3편을 추가 발행(일일 상한 무시 FORCE).
# 마커(.kickstart-done)로 정확히 1회만 실행(cron `0 18 14 7 *` 이 내년에 재발화해도 스킵).
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs state/shorts-curiosity

MARKER="state/shorts-curiosity/.kickstart-done"
LOG="runs/curiosity-slot-$(date +%F).log"
LOCK="state/shorts-curiosity/slot.lock"

if [ -f "$MARKER" ]; then
  echo "[kickstart] 이미 실행됨($MARKER) → 스킵 $(date -u +%FT%TZ)" >> "$LOG"
  exit 0
fi

echo "=== curiosity KICKSTART x3 $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"
# FORCE=1: 일일 상한 무시. N=3. flock 로 recurring 18:00 슬롯과 직렬화(중복 방지).
CURIOSITY_SLOT_N=3 CURIOSITY_FORCE=1 flock "$LOCK" node --env-file=.env scripts/shorts-curiosity/slot.mjs >> "$LOG" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  touch "$MARKER"
  echo "[kickstart] 완료·마커 기록 $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "[kickstart] 종료코드 $rc (마커 미기록 — 다음 발화 시 재시도) $(date -u +%FT%TZ)" >> "$LOG"
fi
exit "$rc"
