#!/usr/bin/env bash
# cardnews-cron.sh — 카드뉴스 발행 슬롯 (WSL cron, KST 11시·19시)
#
# 하루 2편을 서로 다른 소재로 낸다 — 11시는 클로드가, 19시는 코덱스가 쓴다
# (근거: .omc/specs/deep-interview-cardnews-dual-generator.md, 사용자 결정 2026-07-31).
# 작가 배정은 이 스크립트가 아니라 오케가 **슬롯 시각(KST)을 읽어** 결정한다
# (`config/cardnews.json` generators.by_hour) — cron 은 깨우기만 한다.
#
# 🔴 발행 상한은 여기가 아니라 코드가 지킨다. `slot.daily_cap`(=2)을 오케가 KST 날짜 기준
#    발행 건수로 대조해 초과분을 `skipped-cap` 으로 흘린다. cron 이 실수로 세 번 깨워도
#    세 번째는 네트워크를 한 번도 열지 않는다 — 인스타는 삭제 API 가 없어 되돌릴 수 없기 때문에
#    가드를 스케줄러가 아니라 코드에 둔다.
#
# ⚠ `cmd || echo "실패"` 로 쓰지 않는다 — 127(파일 부재 = 미실행)조차 성공처럼 보인다
#   (2026-07-23 교훈). rc 를 그대로 로그에 남기고 종료코드로 반영한다.
#
# 마스터 스위치는 `config/cardnews.json` 의 `publish.enabled` 다. false 인 동안 이 스크립트를
# 걸어둬도 실제 게시는 일어나지 않는다(제작·게이트까지만 돌고 pending 으로 보존).
set -uo pipefail
export PATH="/home/user/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/home/user"
REPO="/home/user/th-team/blog-publisher"
cd "$REPO" || exit 1
mkdir -p runs

LOG="runs/cardnews-run-$(date +%F).log"
LOCK="state/cardnews/run.lock"
mkdir -p "$(dirname "$LOCK")"

echo "=== cardnews run $(date -u +%FT%TZ) (KST $(date '+%F %T')) ===" >> "$LOG"

# flock -n: 앞 슬롯이 아직 도는 중이면 즉시 종료. 제작 한 건이 수 분 걸리므로 11시 런이
# 길어지는 날 19시 런과 겹칠 수 있고, 겹치면 같은 소재를 두 번 집을 위험이 있다.
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "[run] 이미 실행 중 — 이번 슬롯 스킵 $(date -u +%FT%TZ)" >> "$LOG"
  exit 0
fi

# --env-file=.env: 스크립트는 .env 를 스스로 읽지 않는다(GSC·네이버 SEO 와 동일 계약).
node --env-file=.env scripts/cardnews/run-cardnews.mjs >> "$LOG" 2>&1
rc=$?
echo "[run] 종료코드 $rc $(date -u +%FT%TZ)" >> "$LOG"
exit "$rc"
