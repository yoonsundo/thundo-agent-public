#!/usr/bin/env bash
# health-cron.sh — WSL cron 이 4시간마다 호출. 🐕 Sheepdog 이 자동화 파이프라인
# (cron 잡·상시 프로세스·크리덴셜)을 점검하고 안전한 문제는 자동복구, 사람 조치가
# 필요한 건 알림한다. 결정론 스크립트 — 파괴적 동작 없음.
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs state/health
LOG="runs/health-$(date +%F).log"

echo "=== sheepdog run $(date -u +%FT%TZ) ===" >> "$LOG"
# flock: 이전 점검이 복구(재트리거)로 길어져도 중복 기동 방지.
flock -n "$REPO/state/health/sheepdog.lock" \
  node --env-file=.env scripts/watchdog/pipeline-health.mjs >> "$LOG" 2>&1 || echo "sheepdog exit=$?" >> "$LOG"
echo "=== sheepdog done $(date -u +%FT%TZ) ===" >> "$LOG"
