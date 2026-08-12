#!/usr/bin/env bash
# keepalive-cron.sh — 티스토리 세션 keep-alive (재로그인 빈도 최소화)
# cron 은 PATH·cwd 가 최소 — node 경로 보장 + repo 로 cd.
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs
LOG="runs/keepalive-$(date +%F).log"
echo "=== keepalive $(date -u +%FT%TZ) ===" >> "$LOG"
node scripts/crosspub/keepalive.mjs >> "$LOG" 2>&1 || echo "keepalive exit=$?" >> "$LOG"
