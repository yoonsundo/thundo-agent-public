#!/usr/bin/env bash
# start-agent-runner.sh — hub agent-runner(채팅 러너 데몬) 기동 스크립트
# @reboot + */5 watchdog cron + 수동 재가동 공용. flock 싱글턴 가드 —
# 데몬이 락을 쥐고 있는 동안 재기동 시도는 no-op (pgrep 방식은 셸 래퍼 오탐이 있어 교체).
set -uo pipefail
# cron 은 PATH 가 최소 — node 경로 보장 (daily-claude-cron.sh 와 동일 규약)
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1

mkdir -p runs state/hub
LOCK_FILE="$REPO/state/hub/agent-runner.lock"

# flock 부재를 "락 보유중"으로 오독하지 않도록 먼저 확인한다.
# 예전 코드는 flock 이 없으면 127 → `!` 반전 → "already running" 으로 exit 0 이었다.
# 그러면 데몬이 영원히 안 뜨는데 */5 watchdog 과 sheepdog 은 계속 정상으로 읽는다(거짓 green).
if ! command -v flock >/dev/null 2>&1; then
  echo "FATAL: flock 없음 — 싱글턴 보장 불가로 기동 중단 (macOS: brew install util-linux)" >&2
  exit 78
fi

# 락 보유자가 있으면(=데몬 생존) 즉시 종료
if ! flock -n "$LOCK_FILE" true 2>/dev/null; then
  echo "agent-runner already running (lock held) — skip"
  exit 0
fi

# flock 이 node 수명 동안 락을 쥔다 — 동시 기동 경쟁도 락에서 원자적으로 해소
nohup flock -n "$LOCK_FILE" node --env-file=.env scripts/hub/agent-runner.mjs >> runs/agent-runner.log 2>&1 &
echo "agent-runner started (wrapper PID=$!)"
