#!/usr/bin/env node
/**
 * gateway-guard.test.mjs — Parrot 원격 게이트웨이(읽기전용 문)의 **입력 필터 회귀 테스트**.
 *
 * 왜 필요한가: 이 게이트웨이가 지키는 불변식은 "AI 가 거래처 서버를 고정 경로에서 읽기만 한다"이다.
 * 그런데 명령 문자열은 결국 원격 sh 가 다시 파싱하므로, 로컬 토큰 검사만으로는 부족하다.
 * 실제로 2026-08-19 감사에서 `cat ~/.ssh/id_rsa` 와 `cat $HOME/...` 가 절대경로·상위경로 검사를
 * 통과한 뒤 원격에서 확장되는 우회가 확인됐다(경로 고정 무력화). 그 회귀를 막는다.
 *
 * 🔴 거래처 서버에 절대 접속하지 않는다. 스크립트에서 ssh 호출 줄과 관찰대상 조회 줄만 치환한
 *    시뮬레이터를 임시 디렉토리에 만들어, "원격에 넘어갈 문자열"까지만 확인한다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'gw-guard-'));

/** 실제 게이트웨이에서 원격 접속부만 제거한 시뮬레이터를 만든다(필터 로직은 원본 그대로). */
function simulator(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const sim = src
    .split('\n')
    .map(line => {
      if (/^HOST="\$\(node /.test(line)) return 'HOST=sim-host';
      if (/^BASE="\$\(node /.test(line)) return 'BASE=/var/www/app';
      if (/^readonly TARGETS=/.test(line)) return '# (테스트: 관찰대상 조회 제거)';
      if (/^readonly HOST BASE$/.test(line)) return '';
      if (/^ssh /.test(line)) return 'echo "REMOTE_CMD: cd $BASE && $CMD"';
      if (/^exec node /.test(line)) return 'echo "RUNNER_OK: $SUB $*"';
      return line;
    })
    .join('\n');
  const p = join(TMP, relPath.replace(/\//g, '_'));
  writeFileSync(p, sim, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/** 게이트웨이 실행 → {allowed, out}. 거부(exit 2)면 allowed=false. */
function run(simPath, ...cmd) {
  try {
    const out = execFileSync('bash', [simPath, ...cmd], { encoding: 'utf8', stdio: 'pipe' });
    return { allowed: out.includes('REMOTE_CMD:') || out.includes('RUNNER_OK:'), out };
  } catch (e) {
    return { allowed: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

const dev = simulator('scripts/report/parrot-remote.sh');
const prod = simulator('scripts/report/parrot-remote-prod.sh');

console.log('\n[1] 정상 읽기 명령은 통과해야 한다');
for (const cmd of ['git log --oneline -3', 'git show HEAD --stat', 'ls src', 'cat package.json']) {
  ok(`허용: ${cmd}`, run(dev, cmd).allowed);
}

console.log('\n[2] 원격 확장으로 경로 고정을 깨는 입력은 차단 (2026-08-19 회귀)');
for (const cmd of ['cat ~/.ssh/id_rsa', 'cat $HOME/.ssh/id_rsa', 'cat ${HOME}/.env', 'grep -r x ~']) {
  const r = run(dev, cmd);
  ok(`차단: ${cmd}`, !r.allowed, `원격 문자열이 생성됨: ${r.out.trim().slice(0, 80)}`);
}

console.log('\n[3] 기존 차단(셸 체이닝·치환·경로이탈·비허용 바이너리)이 유지된다');
const mustDeny = [
  'git log; id', 'git log && id', 'git log | id', 'cat x > y',
  'cat `id`', 'cat $(id)', 'cat /etc/passwd', 'cat ../../etc/passwd',
  'rm -rf .', 'curl http://evil', 'git push origin main', 'find . -exec id ;',
];
for (const cmd of mustDeny) ok(`차단: ${cmd}`, !run(dev, cmd).allowed);

console.log('\n[4] prod 게이트웨이는 git 읽기 전용 + 동일한 확장 차단');
ok('허용: git rev-parse HEAD', run(prod, 'git rev-parse HEAD').allowed);
for (const cmd of ['cat ~/.ssh/id_rsa', 'cat $HOME/.env', 'ls src', 'git push origin main']) {
  ok(`차단: ${cmd}`, !run(prod, cmd).allowed);
}

console.log('\n[5] git 옵션 화이트리스트 — 읽기 서브명령의 쓰기 프리미티브 차단 (2026-08-19)');
// `git log --output=<경로>` 는 서브명령만 보면 "읽기"인데 커밋 제목 바이트를 파일에 쓴다(실측).
for (const cmd of [
  'git log -1 --format=%s --output=.ssh/authorized_keys',
  'git show HEAD --output=x',
  'git diff --output=evil',
  'git log -c core.pager=id',
  'git log --exec-path=/tmp',
  'git log --upload-pack=/tmp/x',
  'find . -fls out.txt',
]) {
  ok(`차단: ${cmd}`, !run(dev, cmd).allowed);
}
for (const cmd of [
  'git log --oneline -20',
  'git show abc123 --stat',
  'git log -1 --pretty=%B',
  'git log --since=2026-08-01 --name-only',
  'git log -- docs/handoff',
  'grep -rn TODO src',
]) {
  ok(`허용(정상 읽기): ${cmd}`, run(dev, cmd).allowed);
}
ok('prod 도 --output 차단', !run(prod, 'git log -1 --format=%s --output=x').allowed);
ok('prod 정상 조회 허용', run(prod, 'git rev-list a..b --oneline').allowed);

console.log('\n[6] recon 게이트웨이 — 파일 경로 인자 제한 (2026-08-19)');
// 주석은 "/tmp·프로젝트 산출물만" 이라고 적혀 있었지만 검사가 없어 홈 디렉토리 파일을 덮어쓸 수 있었다.
const recon = simulator('scripts/recon/recon-gateway.sh');
for (const args of [
  ['capture', '--url', 'http://x/', '--out', '/home/user/.bashrc'],
  ['capture', '--url', 'http://x/', '--cookies', '/home/user/.secrets/gsc-sa.json'],
  ['replay', '--cap', '/etc/passwd'],
]) {
  ok(`차단: ${args.join(' ')}`, !run(recon, ...args).allowed);
}
for (const args of [
  ['capture', '--url', 'http://x/', '--out', '/tmp/cap.json'],
  ['capture', '--url', 'http://x/', '--out', '.omc/artifacts/cap.json'],
  ['capture', '--url', 'http://x/', '--filter', '/api/v1'],
]) {
  ok(`허용: ${args.join(' ')}`, run(recon, ...args).allowed);
}

console.log('\n[7] 글로빙 경로 이탈 — 원격 셸 재확장 차단 (2026-08-19 2차, 리뷰어 F1)');
// 로컬 `set -f` 는 게이트웨이 프로세스의 확장만 끈다. 최종 ssh 는 문자열을 원격 셸에 넘기고,
// POSIX sh(dash)는 `.*` 를 `./` `../` 로 확장한다(실측 확인) → `.` 이 연속하지 않아 `..` 검사도 통과.
for (const cmd of [
  'cat .*/.*/.*/etc/passwd',
  'cat .?/.?/.?/etc/passwd',
  'cat .[.]/.[.]/etc/passwd',
  'head -c 200 .*/.*/root/.bashrc',
  'grep -r secret .*/.*',
  'git log --stat .*/.*',
]) {
  ok(`차단(글롭): ${cmd}`, !run(dev, cmd).allowed);
}
ok('prod 도 글롭 차단', !run(prod, 'git log .*/.*').allowed);

console.log(`\n게이트웨이 가드: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
