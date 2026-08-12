#!/usr/bin/env node
/**
 * run-all-gates.mjs — 게이트 순차 실행 & 결과 집계
 * dup → length → banned → lint → links → empty → ai-tells → sources →
 * credibility → density → hedge → internal-dup → niche → render-fit
 * (build/deploy는 별도 인자 필요해 run-all에서 제외, 직접 호출)
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄 {all_pass, gates:[GateResult], evidence:{git_sha,build_hash,url_status}}
 * exit: 0=전부 통과 / 1=하나라도 실패 / 2=실행오류
 */
import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));

const GATE_SCRIPTS = [
  'check-dup.mjs',
  'check-length.mjs',
  'check-banned.mjs',
  'check-lint.mjs',
  'check-links.mjs',
  'check-empty.mjs',
  'check-ai-tells.mjs',
  'check-sources.mjs',
  'check-credibility.mjs',
  'check-density.mjs',
  'check-hedge.mjs',
  'check-internal-dup.mjs',
  'check-niche.mjs',
  'check-render-fit.mjs',
  'check-seo.mjs',
  'check-source-fidelity.mjs',   // 게이트16 — 소스 사실 대조 (S3a shadow 기본, config/source-pack.json gate_enforce)
];

/** git SHA (HEAD) — 없으면 null */
function getGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: resolve(__dir, '../../'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** 단일 게이트 스크립트 실행 → GateResult 파싱 */
async function runGate(scriptName, draftPath) {
  const scriptPath = resolve(__dir, scriptName);
  const gateName = scriptName.replace('check-', '').replace('.mjs', '');

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync(
      process.execPath, // node 바이너리 (절대경로, shell 확장 없음)
      [scriptPath, draftPath],
      { timeout: 60_000 }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e) {
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = e.code ?? 2;
    if (stderr) process.stderr.write(`[${gateName}] ${stderr}`);
  }

  // stdout 첫 줄 JSON 파싱
  const firstLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
  if (!firstLine) {
    return {
      gate: gateName,
      pass: false,
      reason: `게이트 출력 파싱 실패 (exit ${exitCode})`,
      evidence: { raw_output: stdout.slice(0, 200) },
    };
  }

  try {
    return JSON.parse(firstLine);
  } catch {
    return {
      gate: gateName,
      pass: false,
      reason: `게이트 JSON 파싱 오류`,
      evidence: { raw_output: firstLine.slice(0, 200) },
    };
  }
}

async function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: run-all-gates.mjs <draft.md>\n');
    process.exit(2);
  }

  const absDraft = resolve(draftPath);
  const git_sha = getGitSha();

  const gates = [];
  for (const script of GATE_SCRIPTS) {
    process.stderr.write(`>> 게이트 실행: ${script}\n`);
    const gateResult = await runGate(script, absDraft);
    gates.push(gateResult);
    const status = gateResult.pass ? 'PASS' : 'FAIL';
    process.stderr.write(`   ${status} — ${gateResult.reason ?? ''}\n`);
  }

  const all_pass = gates.every(g => g.pass);

  const result = {
    all_pass,
    gates,
    evidence: {
      git_sha,
      build_hash: null, // check-build는 별도 실행
      url_status: null, // check-deploy는 별도 실행
    },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(all_pass ? 0 : 1);
}

main();
