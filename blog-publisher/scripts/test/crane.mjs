#!/usr/bin/env node
/**
 * scripts/test/crane.mjs — Crane 건강검진 도구 스모크 테스트
 *
 * 검증 항목:
 *   1. incident 탐지: agent-health incident 있는 run.json → findings≥1·escalate=true·exit 1
 *   2. no_run 방어: run.json 없는 날 → status=no_run·healthy·exit 0 (크래시 없음)
 *   3. 스키마 A(drafts[]·zero_published) → zero-published 소견 검출(양 스키마 방어)
 *   4. 건강한 런(발행>0·incident 0) → healthy=true·exit 0
 *   5. state 기록: --state-dir 격리 경로에 crane-health.json + jsonl 생성
 *   6. read-only: runs-dir(입력) 미변경 — 산출은 state-dir 로만
 *
 * 모든 케이스는 임시 --runs-dir/--state-dir 로 격리 → 라이브 runs/·state/ 미오염.
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const SCRIPTS_DIR = resolve(TEST_DIR, '..');
const CHECK = join(SCRIPTS_DIR, 'crane', 'health-check.mjs');

let passCount = 0, failCount = 0;
const pass = (l) => { console.log(`  [PASS] ${l}`); passCount++; };
const fail = (l, d = '') => { console.error(`  [FAIL] ${l}${d ? ': ' + d : ''}`); failCount++; };

async function runCheck(args = []) {
  try {
    const r = await execFileAsync(process.execPath, [CHECK, ...args], { timeout: 30_000 });
    return { exit: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function parseJson(stdout) { const line = stdout.split('\n').find(l => l.trim().startsWith('{')); return line ? JSON.parse(line) : null; }
function writeRun(runsDir, date, obj) { mkdirSync(join(runsDir, date), { recursive: true }); writeFileSync(join(runsDir, date, 'run.json'), JSON.stringify(obj), 'utf8'); }

async function main() {
  console.log('=== crane.mjs 건강검진 스모크 시작 ===');
  const base = mkdtempSyncSafe();
  const runsDir = join(base, 'runs');
  const stateDir = join(base, 'state');
  const R = `--runs-dir=${runsDir}`;
  const S = `--state-dir=${stateDir}`;

  try {
    // 1. incident 탐지 (스키마 B: published[]/incidents[])
    writeRun(runsDir, '2099-01-02', {
      status: 'published_3',
      published: [{ slug: 'a', gate_attempts: 1, final: 'all_pass' }, { slug: 'b', gate_attempts: 4, final: 'all_pass' }, { slug: 'c', gate_attempts: 1, final: 'all_pass' }],
      incidents: [{ kind: 'agent-health', agent: 'wolf', symptom: 'Write 미호출 허위 완료', action: 'crane 점검 대상' }],
      selection: { diversity: { single_channel_violation: false } },
    });
    const inc = await runCheck(['2099-01-02', R, S]);
    const ij = parseJson(inc.stdout);
    if (inc.exit === 1 && ij && ij.findings.length >= 1 && ij.escalate === true &&
        ij.findings.some(f => f.agent === 'wolf' && (f.kind || '').includes('health'))) {
      pass(`incident 탐지 → findings ${ij.findings.length}건·escalate=${ij.escalate}·exit 1`);
    } else {
      fail('incident 탐지', `exit ${inc.exit}, ${JSON.stringify(ij?.findings)?.slice(0, 160)}`);
    }

    // 2. no_run 방어
    const nr = await runCheck(['2099-12-31', R, S]);
    const nj = parseJson(nr.stdout);
    if (nr.exit === 0 && nj && nj.run_status === 'no_run' && nj.healthy === true && nj.findings.length === 0) {
      pass('no_run 방어 → status=no_run·healthy·exit 0');
    } else {
      fail('no_run 방어', `exit ${nr.exit}, ${JSON.stringify(nj)?.slice(0, 160)}`);
    }

    // 3. 스키마 A (drafts[]·zero_published)
    writeRun(runsDir, '2099-01-03', {
      status: 'zero_published',
      drafts: [{ writer: 'beaver', attempts: [{ gate_gates: [{ name: 'length', pass: false }] }, {}, {}] }],
    });
    const za = await runCheck(['2099-01-03', R, S]);
    const zj = parseJson(za.stdout);
    if (za.exit === 1 && zj && zj.findings.some(f => f.kind === 'zero-published')) {
      pass(`스키마 A(drafts[]) zero_published 소견 검출 (${zj.findings.map(f => f.kind).join(',')})`);
    } else {
      fail('스키마 A zero_published', `exit ${za.exit}, ${JSON.stringify(zj?.findings)?.slice(0, 160)}`);
    }

    // 4. 건강한 런
    writeRun(runsDir, '2099-01-04', {
      status: 'published_2',
      published: [{ slug: 'a', gate_attempts: 1, final: 'all_pass' }, { slug: 'b', gate_attempts: 2, final: 'all_pass' }],
      incidents: [],
      selection: { diversity: { single_channel_violation: false } },
    });
    const ok = await runCheck(['2099-01-04', R, S]);
    const okj = parseJson(ok.stdout);
    if (ok.exit === 0 && okj && okj.healthy === true && okj.findings.length === 0) {
      pass('건강한 런 → healthy=true·exit 0');
    } else {
      fail('건강한 런', `exit ${ok.exit}, ${JSON.stringify(okj)?.slice(0, 160)}`);
    }

    // 5. state 기록 (앞 케이스들이 persist 했어야 함)
    const latest = join(stateDir, 'crane-health.json');
    const jsonl = join(stateDir, 'crane-health.jsonl');
    if (existsSync(latest) && existsSync(jsonl)) {
      const lines = readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= 4) pass(`state 기록 → crane-health.json + jsonl(${lines.length}줄)`);
      else fail('state jsonl 누적', `${lines.length}줄 (<4)`);
    } else {
      fail('state 기록', 'crane-health.json/jsonl 미생성');
    }

    // 6. read-only: 입력 runs-dir 에는 run.json 만 존재(도구가 입력을 안 건드림)
    const stray = readdirSync(join(runsDir, '2099-01-02')).filter(f => f !== 'run.json');
    if (stray.length === 0) pass('read-only → 입력 runs-dir 미변경');
    else fail('read-only 위반', `runs-dir 에 산출물 유출: ${stray.join(',')}`);
  } finally {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  }

  finish();
}

function mkdtempSyncSafe() {
  // mkdtempSync 는 argless Date/random 불필요 — os.tmpdir 기반 고유 접미사를 pid 로 생성
  const d = join(tmpdir(), `crane-test-${process.pid}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function finish() {
  console.log(`\n=== 결과: ${passCount}/${passCount + failCount} 통과 ===`);
  if (failCount > 0) { console.error(`[FAIL] ${failCount}개 실패`); process.exit(1); }
  console.log('[PASS] 전체 통과'); process.exit(0);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
