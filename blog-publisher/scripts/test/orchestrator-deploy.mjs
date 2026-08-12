/**
 * test/orchestrator-deploy.mjs — 승인 후 완전 자동 반영 파이프라인 단위·통합 테스트.
 *
 * 완전 hermetic: 임시 git 저장소(로컬 bare origin)만 쓰고 네트워크·thundorun·prod 를
 * 절대 건드리지 않는다. 배포는 dry_run 으로 실제 push 없이 로컬 커밋까지만 검증한다.
 *
 * 실행: node scripts/test/orchestrator-deploy.mjs   (exit 0=통과, 1=실패)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sanitizeBranch, isDevRequest, killswitchActive, buildDeployDoneContent,
  ensureWorktree, removeWorktree, finalizeDeploy, deployEnabled, loadDeployConfig,
} from '../hub/orchestrator-deploy.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.error(`✗ ${name} ${extra}`); } }
function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

// ─── 1) sanitizeBranch: 안전한 브랜치명 정규화 ────────────────────────────────
ok('sanitize: 정상 통과', sanitizeBranch('feat/notice', 'req1') === 'feat/notice');
ok('sanitize: 공백→하이픈', sanitizeBranch('feat notice page', 'req1') === 'feat-notice-page');
ok('sanitize: 선두 슬래시/대시 제거', !/^[/-]/.test(sanitizeBranch('/-evil', 'req1')));
ok('sanitize: 경로이탈(..) 차단', !sanitizeBranch('../../etc/x', 'req1').includes('..'));
ok('sanitize: 위험문자 제거', sanitizeBranch('a;rm -rf b`$()', 'req1').match(/^[A-Za-z0-9._/-]+$/) !== null);
ok('sanitize: 빈값→요청id 폴백', sanitizeBranch('', 'reqABC') === 'orchestrator/reqABC');

// ─── 2) isDevRequest: worktree 유무로 판별 ────────────────────────────────────
ok('isDev: worktree 있으면 true', isDevRequest({ worktree: 'feat/x' }) === true);
ok('isDev: worktree null 이면 false', isDevRequest({ worktree: null }) === false);
ok('isDev: worktree 공백이면 false', isDevRequest({ worktree: '   ' }) === false);

// ─── 3) killswitchActive: 절대경로 파일 유무로 토글 ──────────────────────────
const ksTmp = mkdtempSync(join(tmpdir(), 'orch-ks-'));
const ksFile = join(ksTmp, 'killswitch');
ok('killswitch: 파일 없으면 false', killswitchActive({ killswitch: ksFile }) === false);
writeFileSync(ksFile, '');
ok('killswitch: 파일 있으면 true', killswitchActive({ killswitch: ksFile }) === true);
rmSync(ksTmp, { recursive: true, force: true });

// ─── 4) buildDeployDoneContent: 상태별 평문 렌더 ─────────────────────────────
const dcReq = { id: 'req_x', title: '공지 페이지', plan: { summary: '공지 등록 페이지를 추가했습니다.' } };
const dcSubs = [{ agent_id: 'coder', result_excerpt: '페이지 구현', exec_status: 'done' }];
const deployed = buildDeployDoneContent({ request: dcReq, subtasks: dcSubs, result: { status: 'deployed', branch: 'feat/notice', url: 'https://www.thundo.kr/' } });
ok('done: 배포됨 → 라이브·URL·브랜치 표기', /라이브 배포 완료/.test(deployed) && /feat\/notice/.test(deployed) && /thundo\.kr/.test(deployed));
ok('done: 진행 내역에 에이전트 요약', /coder: 페이지 구현/.test(deployed));
const nochange = buildDeployDoneContent({ request: dcReq, subtasks: dcSubs, result: { status: 'nochange', branch: 'feat/x', note: '변경 없음' } });
ok('done: 변경없음 표기', /배포할 내용이 없습니다/.test(nochange));
const errd = buildDeployDoneContent({ request: dcReq, subtasks: dcSubs, result: { status: 'error', branch: 'feat/x', note: '실패사유' } });
ok('done: 오류 시 작업물 브랜치 보존 안내', /브랜치 `feat\/x` 에 보존/.test(errd));

// ─── 5) 통합: 임시 저장소 + dry-run finalize (네트워크·prod 무접촉) ──────────
let repoRoot;
try {
  const base = mkdtempSync(join(tmpdir(), 'orch-repo-'));
  const originDir = join(base, 'origin.git');
  const workDir   = join(base, 'work');
  const wtDir      = join(base, 'wt');
  mkdirSync(originDir); mkdirSync(workDir);
  git(originDir, ['init', '--bare', '-b', 'main']);
  git(workDir, ['init', '-b', 'main']);
  git(workDir, ['config', 'user.name', 'yoonsundo']);
  git(workDir, ['config', 'user.email', '168806235+yoonsundo@users.noreply.github.com']);
  mkdirSync(join(workDir, 'web', 'supabase'), { recursive: true });
  writeFileSync(join(workDir, 'README.md'), 'seed\n');
  git(workDir, ['add', '-A']);
  git(workDir, ['commit', '-m', 'seed']);
  git(workDir, ['remote', 'add', 'origin', originDir]);
  git(workDir, ['push', '-u', 'origin', 'main']);

  const cfg = {
    enabled: true, repo_path: workDir, base_branch: 'main',
    worktrees_dir: wtDir, deploy_url: 'http://127.0.0.1:9/never',
    author_name: 'yoonsundo', author_email: '168806235+yoonsundo@users.noreply.github.com',
    killswitch: join(base, 'no-killswitch'), dry_run: true,
  };

  // 5a) ensureWorktree — origin/main 에서 격리 워크트리 생성
  const wt = ensureWorktree(cfg, 'feat/auto-test');
  ok('worktree: 생성됨', existsSync(wt));
  ok('worktree: 재호출 멱등(같은 경로)', ensureWorktree(cfg, 'feat/auto-test') === wt);

  // 5b) 에이전트가 파일을 바꿨다고 가정 → dry-run finalize → 로컬 커밋만, push/배포 스킵
  mkdirSync(join(wt, 'web'), { recursive: true });
  writeFileSync(join(wt, 'web', 'notice.txt'), 'new page\n');
  const req = { id: 'req_int', title: '공지', worktree: 'feat/auto-test', session_id: null, status: 'approved', plan: { summary: '공지 추가' } };
  const res = await finalizeDeploy(cfg, { request: req, subtasks: [{ agent_id: 'coder', result_excerpt: 'x', exec_status: 'done' }], log: { info(){}, warn(){}, error(){} } });
  ok('finalize(dry): status=deployed', res.status === 'deployed', JSON.stringify(res));
  const author = git(wt, ['log', '-1', '--format=%an <%ae>']);
  ok('finalize(dry): 커밋 author=yoonsundo', author === 'yoonsundo <168806235+yoonsundo@users.noreply.github.com>', author);
  // dry-run 은 push 안 함 → origin main 은 seed 그대로(자동배포가 실제로 안 나갔음을 증명)
  const originMain = git(originDir, ['log', '--format=%s', 'main']);
  ok('finalize(dry): origin/main 미변경(실배포 안 나감)', originMain.split('\n')[0] === 'seed', originMain);

  // 5c) author 게이트: 잘못된 author → 커밋 전 거부
  const badCfg = { ...cfg, author_email: 'attacker@evil.com' };
  const badRes = await finalizeDeploy(badCfg, { request: req, subtasks: [], log: { info(){}, warn(){}, error(){} } });
  ok('author-gate: yoonsundo 아니면 error 거부', badRes.status === 'error' && /yoonsundo/.test(badRes.note), JSON.stringify(badRes));

  // 5d) nochange: 변경 없는 새 워크트리 → nochange
  const wt2 = ensureWorktree(cfg, 'feat/empty');
  const emptyRes = await finalizeDeploy(cfg, { request: { ...req, worktree: 'feat/empty' }, subtasks: [], log: { info(){}, warn(){}, error(){} } });
  ok('nochange: 파일 변경 없으면 nochange', emptyRes.status === 'nochange', JSON.stringify(emptyRes));

  // 5e) killswitch: 활성 시 커밋만(committed_only), 배포 스킵
  writeFileSync(cfg.killswitch, '');
  const wt3 = ensureWorktree(cfg, 'feat/ks');
  writeFileSync(join(wt3, 'x.txt'), 'y\n');
  const ksRes = await finalizeDeploy(cfg, { request: { ...req, worktree: 'feat/ks' }, subtasks: [], log: { info(){}, warn(){}, error(){} } });
  ok('killswitch: 활성 시 committed_only', ksRes.status === 'committed_only', JSON.stringify(ksRes));
  rmSync(cfg.killswitch, { force: true });

  // 5e-2) killswitch 활성이라도 skipKillswitch:true(관리자 완료 처리 트리거)면 우회해 배포 진행
  writeFileSync(cfg.killswitch, '');
  const wt3b = ensureWorktree(cfg, 'feat/ks-skip');
  writeFileSync(join(wt3b, 'z.txt'), 'z\n');
  const ksSkip = await finalizeDeploy(cfg, { request: { ...req, worktree: 'feat/ks-skip' }, subtasks: [{ agent_id: 'coder', result_excerpt: 'x', exec_status: 'done' }], log: { info(){}, warn(){}, error(){} }, skipKillswitch: true });
  ok('killswitch: skipKillswitch 면 우회해 배포(dry deployed)', ksSkip.status === 'deployed', JSON.stringify(ksSkip));
  rmSync(cfg.killswitch, { force: true });
  removeWorktree(cfg, 'feat/ks-skip');

  // 5f) removeWorktree — 워크트리 정리(디스크 누수 방지)
  const wt4 = ensureWorktree(cfg, 'feat/cleanup');
  ok('removeWorktree: 생성 확인', existsSync(wt4));
  removeWorktree(cfg, 'feat/cleanup');
  ok('removeWorktree: 제거됨', !existsSync(wt4));

  // 5g) 방어심화 — 비-dev 요청(worktree 없음)은 finalizeDeploy 가 거부
  const nonDev = await finalizeDeploy(cfg, { request: { id: 'req_p', title: 'x', worktree: null, session_id: null }, subtasks: [], log: { info(){}, warn(){}, error(){} } });
  ok('finalize: 비-dev 요청 거부', nonDev.status === 'error' && /비-dev/.test(nonDev.note), JSON.stringify(nonDev));

  rmSync(base, { recursive: true, force: true });
} catch (e) {
  fail++; console.error(`✗ 통합 테스트 예외: ${e.message}\n${e.stack}`);
} finally {
  if (repoRoot && existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
}

// ─── 6) 실제 config 위생 검사 ────────────────────────────────────────────────
const realCfg = loadDeployConfig();
ok('config: author_email=yoonsundo', realCfg.author_email === '168806235+yoonsundo@users.noreply.github.com', realCfg.author_email);
ok('config: repo_path 존재', !!realCfg.repo_path);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
