#!/usr/bin/env bash
# curiosity-slot-cron.sh — WSL cron 이 슬롯 시각(10/18 KST)마다 호출 + 21시 결손보충.
# 호기심 쇼츠 1편(또는 CURIOSITY_SLOT_N)을 produce+upload. 일일 상한(slot.mjs)으로 과다발행 방지.
# 환경(cron 은 PATH 최소): node 경로·HOME 보장. flock 로 동시실행 차단(중복 발행 방지).
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/curiosity-slot-$(date +%F).log"
LOCK="state/shorts-curiosity/slot.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== curiosity slot $(date -u +%FT%TZ) (KST $(date '+%F %T'), N=${CURIOSITY_SLOT_N:-1} FORCE=${CURIOSITY_FORCE:-0}) ===" >> "$LOG"

# flock -n: 이미 슬롯이 도는 중이면 즉시 종료(중복 발행 방지). --env-file 로 .env 주입(스톡키 등).
flock -n "$LOCK" node --env-file=.env scripts/shorts-curiosity/slot.mjs >> "$LOG" 2>&1
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "[slot] 정상 종료 $(date -u +%FT%TZ)" >> "$LOG"
else
  echo "[slot] 종료코드 $rc $(date -u +%FT%TZ)" >> "$LOG"
fi
exit "$rc"
