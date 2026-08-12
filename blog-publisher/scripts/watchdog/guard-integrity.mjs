#!/usr/bin/env node
// L3 가드 무결성 결정론 검사 — meerkat/elephant가 결과를 "인용"한다(자기채점 아님).
// L1(.claude/settings.json deny) + L2(.git/hooks/pre-push) 가 존재·무결한지 검증.
// stdout=JSON 단일 진실, exit 0=정상 1=위반 2=실행오류 (프로젝트 게이트/감사 계약 동일).
// 근거: docs/topology-setup.md
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

// L1에서 반드시 존재해야 하는 핵심 deny 규칙 (이게 빠지면 강제 경계가 뚫린 것)
const REQUIRED_DENY = [
  'Bash(git push --force:*)',
  'Bash(git push --no-verify:*)',
  'Bash(git push --delete:*)',
  'Bash(git config core.hooksPath:*)',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const result = {
  actor: 'guard-integrity',
  ok: true,
  checks: {},
  violations: [],
  checked_at: new Date().toISOString(),
};

try {
  // ── L1: 하네스 deny 규칙 존재 검증 ─────────────────────────────
  const settingsPath = '.claude/settings.json';
  if (!existsSync(settingsPath)) {
    result.violations.push('L1: .claude/settings.json 없음 (deny 규칙 전체 소실)');
    result.checks.settings_deny = { ok: false, missing: REQUIRED_DENY };
  } else {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const denyList = (s.permissions && s.permissions.deny) || [];
    const missing = REQUIRED_DENY.filter((d) => !denyList.includes(d));
    result.checks.settings_deny = { ok: missing.length === 0, missing, total_deny: denyList.length };
    if (missing.length) result.violations.push(`L1: 필수 deny 규칙 누락 ${JSON.stringify(missing)}`);
  }

  // ── L2: pre-push hook 설치본 == 정규본(버전관리) ───────────────
  const canonical = 'scripts/git-hooks/pre-push';
  const installed = '.git/hooks/pre-push';
  if (!existsSync(canonical)) {
    result.violations.push('L2: 정규 hook(scripts/git-hooks/pre-push) 없음');
    result.checks.pre_push_hook = { ok: false, reason: 'canonical_missing' };
  } else if (!existsSync(installed)) {
    result.violations.push('L2: 설치 hook(.git/hooks/pre-push) 없음 — 미설치 또는 삭제됨');
    result.checks.pre_push_hook = { ok: false, reason: 'not_installed' };
  } else {
    const cHash = sha256(readFileSync(canonical));
    const iHash = sha256(readFileSync(installed));
    const execOk = (statSync(installed).mode & 0o111) !== 0;
    const match = cHash === iHash;
    result.checks.pre_push_hook = {
      ok: match && execOk, match, executable: execOk,
      canonical_sha256: cHash.slice(0, 16), installed_sha256: iHash.slice(0, 16),
    };
    if (!match) result.violations.push('L2: 설치 hook이 정규본과 불일치 (변조 의심)');
    if (!execOk) result.violations.push('L2: 설치 hook 실행권한 없음 (무력화됨)');
  }

  // ── L2b: core.hooksPath 우회 안 됐나 ──────────────────────────
  let hooksPath = '';
  try { hooksPath = execSync('git config --get core.hooksPath', { encoding: 'utf8' }).trim(); }
  catch { hooksPath = ''; }
  const hpOk = hooksPath === '' || hooksPath === '.git/hooks';
  result.checks.hooks_path = { ok: hpOk, value: hooksPath || '(default) .git/hooks' };
  if (!hpOk) result.violations.push(`L2: core.hooksPath가 우회됨 → ${hooksPath}`);
} catch (e) {
  console.log(JSON.stringify({ actor: 'guard-integrity', ok: false, error: String((e && e.message) || e), exit: 2 }, null, 2));
  process.exit(2);
}

result.ok = result.violations.length === 0;
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
