#!/usr/bin/env bash
# token-cron.sh — 인스타 장기 토큰 갱신 점검 (WSL cron, 매일 03:30 KST)
#
# 인스타 장기 토큰은 60일짜리이고 **자동 갱신이 없다** — 45일째부터 갱신을 시도하고,
# 50일째부터 매일 재시도, 55일째에 사람에게 에스컬레이션한다(config `token.*`).
#
# 오케(`run-cardnews.mjs`)도 매 슬롯 시작에 같은 점검을 돌린다. 그런데도 이 cron 이 따로
# 있는 이유는, **발행이 멈춘 날에는 오케가 일찍 빠져나갈 수 있기 때문**이다 — 예산 소진·
# killswitch·상한 스킵으로 오케가 조기 반환하는 날이 이어지면 토큰 점검도 같이 건너뛰어지고,
# 그러다 60일이 지나면 재인증 없이는 되살릴 수 없다(갱신 창을 놓치면 새 OAuth 뿐이다).
# 발행 경로와 **독립적으로** 도는 점검이 하나 필요하다.
#
# 아무것도 게시하지 않는다. 크리덴셜이 없으면 warn + exit 0 으로 빠지므로 계정 설정 전에
# 걸어둬도 안전하다.
#
# ⚠ `cmd || echo "실패"` 로 쓰지 않는다 — 127(파일 부재 = 미실행)조차 성공처럼 보인다.
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/cardnews-token-$(date +%F).log"
LOCK="state/cardnews/token.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== cardnews token $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"

exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[token] 이미 실행 중 — 이번 회차 스킵 $(date -u +%FT%TZ)" >> "$LOG"
  exit 0
fi

node --env-file=.env scripts/cardnews/token.mjs >> "$LOG" 2>&1
rc=$?
echo "[token] 종료코드 $rc $(date -u +%FT%TZ)" >> "$LOG"
exit "$rc"
