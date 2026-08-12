#!/usr/bin/env node
/**
 * scripts/test/meerkat.mjs — Meerkat 준수 감사 도구 회귀 테스트
 *
 * 검증 항목:
 *   1. compliance-audit 실행 (exit 0/1, not 2) + JSON 스키마 확인
 *   2. 15개 에이전트 전수 점검됨 + meerkat 포함
 *   3. 기존 에이전트 전원 준수(all_compliant=true) — 캘리브레이션 회귀 방지
 *   4. meerkat 자신도 준수(감독 read-only 등)
 *   5. 단건 감사 동작 (argv 필터)
 *   6. 위키 lint(--wiki) 동작 + 고아 0
 *   7. 위반 검출력: 임시 결손 에이전트는 비준수로 잡힘 (판별력)
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const SCRIPTS_DIR = resolve(TEST_DIR, '..');
const ROOT_DIR = resolve(SCRIPTS_DIR, '..');
const AUDIT = join(SCRIPTS_DIR, 'meerkat', 'compliance-audit.mjs');

let passCount = 0, failCount = 0;
const pass = (l) => { console.log(`  [PASS] ${l}`); passCount++; };
const fail = (l, d = '') => { console.error(`  [FAIL] ${l}${d ? ': ' + d : ''}`); failCount++; };

async function runAudit(args = []) {
  try {
    const r = await execFileAsync(process.execPath, [AUDIT, ...args], { timeout: 60_000 });
    return { exit: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function parseJson(stdout) {
  const line = stdout.split('\n').find(l => l.trim().startsWith('{'));
  return line ? JSON.parse(line) : null;
}

async function main() {
  console.log('=== meerkat.mjs 준수 감사 테스트 시작 ===');

  // 1. 전수 감사
  const r = await runAudit();
  if (r.exit === 2) return fail('audit 실행', `exit 2\n${r.stderr.slice(0, 300)}`), finish();
  let rep;
  try { rep = parseJson(r.stdout); } catch (e) { return fail('JSON 파싱', e.message), finish(); }
  if (!rep || rep.tool !== 'meerkat-compliance-audit' || typeof rep.all_compliant !== 'boolean') {
    return fail('출력 스키마', JSON.stringify(rep)?.slice(0, 120)), finish();
  }
  pass(`audit 실행 → exit ${r.exit}, all_compliant=${rep.all_compliant}`);

  // 2. 15개 + meerkat 포함
  if (rep.agents_checked >= 15) pass(`에이전트 ${rep.agents_checked}개 점검`);
  else fail('에이전트 수', `${rep.agents_checked} (<15)`);
  if (rep.summary.some(s => s.agent === 'meerkat')) pass('meerkat 포함');
  else fail('meerkat 미포함');

  // 3. 전원 준수 (캘리브레이션 회귀 방지) — 프로세스 exit + all_compliant 직접 단언
  if (r.exit === 1 || !rep.all_compliant) {
    fail('전원 준수 아님', rep.summary.filter(s => !s.compliant).map(s => s.agent).join(','));
  } else {
    pass('기존+신규 에이전트 전원 준수');
  }

  // 4. meerkat 자신 준수 (감독 read-only)
  const mk = rep.summary.find(s => s.agent === 'meerkat');
  if (mk && mk.compliant) pass(`meerkat 준수 (score ${mk.score})`);
  else fail('meerkat 비준수', JSON.stringify(mk?.violations));

  // 5. 단건 감사
  const single = await runAudit(['lion']);
  const sj = parseJson(single.stdout);
  if (sj && sj.agents_checked === 1 && sj.summary[0].agent === 'lion') pass('단건 감사(lion)');
  else fail('단건 감사', JSON.stringify(sj)?.slice(0, 120));

  // 6. 위키 lint
  const wiki = await runAudit(['--wiki']);
  const wj = parseJson(wiki.stdout);
  if (wj && wj.wiki_lint && wj.wiki_lint.present) {
    const orphans = wj.wiki_lint.orphans?.length ?? 0;
    if (orphans === 0) pass(`위키 lint → 고아 0, pages=${wj.wiki_lint.pages}`);
    else fail('위키 고아', wj.wiki_lint.orphans.join(','));
  } else fail('위키 lint', JSON.stringify(wj?.wiki_lint)?.slice(0, 120));

  // 7. 판별력: 결손 에이전트 주입 → 비준수로 검출되는지 (격리 temp 디렉토리, 라이브 dir 미오염)
  const tmpDir = mkdtempSync(join(tmpdir(), 'meerkat-test-'));
  try {
    writeFileSync(join(tmpDir, 'broken.md'), '---\nname: wrongname\n---\n빈 에이전트(계약 결손)\n', 'utf8');
    const broken = await runAudit([`--agents-dir=${tmpDir}`, 'broken']);
    const bj = parseJson(broken.stdout);
    if (broken.exit === 1 && bj && !bj.summary[0].compliant && bj.summary[0].violations.length > 0) {
      pass(`판별력 → 결손 에이전트 비준수 검출 (위반 ${bj.summary[0].violations.length}건)`);
    } else {
      fail('판별력', `exit ${broken.exit}, compliant=${bj?.summary?.[0]?.compliant}`);
    }
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }

  finish();
}

function finish() {
  console.log(`\n=== 결과: ${passCount}/${passCount + failCount} 통과 ===`);
  if (failCount > 0) { console.error(`[FAIL] ${failCount}개 실패`); process.exit(1); }
  console.log('[PASS] 전체 통과'); process.exit(0);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
