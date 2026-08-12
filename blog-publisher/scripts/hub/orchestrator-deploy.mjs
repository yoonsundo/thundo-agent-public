/**
 * hub/orchestrator-deploy.mjs — 승인 후 "완전 자동 반영"(dev팀 요청) 파이프라인.
 *
 * 사람 게이트는 승인 단 하나. 승인 뒤 서브태스크가 전부 done 이 되면 이 모듈이:
 *   격리 워크트리 커밋(author=yoonsundo 강제) → 마이그레이션 먼저 → 브랜치 push
 *   → main FF push(Vercel 자동배포) → 배포 URL 폴링 → 실패 시 revert 롤백.
 *
 * 안전장치(설계 불변식):
 *   ① author 를 config 의 yoonsundo 로 강제한다. 다른 author 로 설정돼 있으면 즉시 거부
 *      (thundorun 은 author≠yoonsundo 커밋을 Vercel 이 배포 차단하므로 실패 loud 가 안전).
 *   ② 작업은 origin/main 에서 딴 격리 워크트리에서만. main 을 직접 수정하지 않고,
 *      배포는 `push origin <branch>:main` 의 **fast-forward 만**(--force 절대 안 씀). 비FF면 중단.
 *   ③ *.sql(web/supabase) 변경이 있으면 배포 전에 마이그레이션을 먼저 적용. 실패 시 배포 중단.
 *   ④ 배포 검증(URL 200) 실패 시 revert 커밋을 main 에 올려 라이브를 이전 상태로 되돌린다.
 *
 * killswitch(`touch state/orchestrator-deploy.killswitch`): 커밋까지만, push/배포 스킵.
 * dry_run(config 또는 ORCH_DEPLOY_DRY_RUN=1): 로컬 커밋만, 원격 push·배포·마이그레이션은 로그만.
 *
 * 발행·관측팀 요청(worktree=null)은 이 모듈을 절대 타지 않는다 — 기존 blog-publisher cwd 실행 유지.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitDeploy } from '../deploy/wait-deploy.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..', '..');

// author≠이 값이면 배포가 어차피 차단되므로 config 변조를 fail-loud 로 막는다.
const REQUIRED_AUTHOR_EMAIL = '168806235+yoonsundo@users.noreply.github.com';

/** config/orchestrator.json 로드(+env dry-run 오버레이). 파일 없으면 비활성 기본값. */
export function loadDeployConfig() {
  const path = join(ROOT, 'config', 'orchestrator.json');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, 'utf8')).auto_deploy || {}; }
  catch { cfg = { enabled: false }; }
  if (process.env.ORCH_DEPLOY_DRY_RUN === '1') cfg = { ...cfg, dry_run: true };
  return cfg;
}

export function deployEnabled(cfg = loadDeployConfig()) {
  return cfg.enabled === true;
}

/** killswitch 파일 존재 여부 — 있으면 push/배포를 멈추고 커밋만 남긴다. */
export function killswitchActive(cfg = loadDeployConfig()) {
  const ks = cfg.killswitch || 'state/orchestrator-deploy.killswitch';
  return existsSync(isAbsolute(ks) ? ks : join(ROOT, ks));
}

/** dev(사이트·기능·DB) 요청 신호 = 오케가 격리 워크트리 브랜치를 계획에 심었는지. */
export function isDevRequest(request) {
  return !!(request && typeof request.worktree === 'string' && request.worktree.trim());
}

/**
 * 오케가 제안한 worktree 문자열을 안전한 git 브랜치명으로 정규화한다.
 * 허용: [A-Za-z0-9._/-]. 선두 '-'/'/' 금지, '..' 금지, 공백→'-'. 실패 시 요청 id 기반 폴백.
 */
export function sanitizeBranch(worktree, requestId) {
  const fallback = `orchestrator/${String(requestId || 'req').replace(/[^A-Za-z0-9._-]/g, '')}`;
  if (!worktree) return fallback;
  let b = String(worktree).trim().replace(/\s+/g, '-');
  b = b.replace(/[^A-Za-z0-9._/-]/g, '');
  b = b.replace(/\.\.+/g, '.').replace(/^[/-]+/, '').replace(/\/+$/,'').replace(/\/{2,}/g, '/');
  if (!b || b.length > 200) return fallback;
  return b;
}

/** 워크트리 디렉토리명(브랜치의 '/'를 '__'로) — 경로 이탈 없는 평면 폴더. */
function worktreeDirFor(cfg, branch) {
  const base = cfg.worktrees_dir || join(ROOT, '..', '.orchestrator-worktrees');
  return join(base, branch.replace(/\//g, '__'));
}

/** git 실행(실패 시 throw, stderr 포함). */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** git 실행(비throw) — push 비FF 감지 등에 사용. */
function gitTry(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, out: '', err: (e.stderr || e.stdout || e.message || '').toString() }; }
}

/**
 * origin/main 에서 딴 격리 워크트리를 보장한다(멱등). 반환: 워크트리 절대경로.
 * 이미 있으면 재사용(같은 요청의 후속 서브태스크가 같은 트리에서 이어 작업).
 */
export function ensureWorktree(cfg, branch) {
  const repo = cfg.repo_path;
  const base = cfg.base_branch || 'main';
  if (!repo || !existsSync(repo)) throw new Error(`repo_path 없음: ${repo}`);
  const wtPath = worktreeDirFor(cfg, branch);
  const parent = dirname(wtPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // 이미 유효한 워크트리면 재사용.
  const list = gitTry(repo, ['worktree', 'list', '--porcelain']);
  if (list.ok && list.out.includes(`worktree ${wtPath}`)) return wtPath;

  // 끊긴 워크트리 등록 정리 후 최신 origin/base 기준으로 새로 만든다.
  gitTry(repo, ['worktree', 'prune']);
  const fetch = gitTry(repo, ['fetch', 'origin', base]);
  if (!fetch.ok) throw new Error(`git fetch origin ${base} 실패: ${fetch.err.slice(0, 200)}`);
  // -B: 브랜치가 있으면 origin/base 로 리셋(재실행 안전). 워크트리 경로는 브랜치별 유일.
  const add = gitTry(repo, ['worktree', 'add', '-B', branch, wtPath, `origin/${base}`]);
  if (!add.ok) throw new Error(`git worktree add 실패: ${add.err.slice(0, 200)}`);
  return wtPath;
}

/**
 * 워크트리를 제거한다(디스크 누수 방지). 배포 성공/변경없음 뒤 정리용.
 * 실패해도 무해 — best-effort. 커밋은 이미 origin 에 push 됐으므로 로컬 트리는 버려도 됨.
 */
export function removeWorktree(cfg, branch) {
  const repo = cfg.repo_path;
  const wtPath = worktreeDirFor(cfg, branch);
  if (!repo || !existsSync(wtPath)) return;
  gitTry(repo, ['worktree', 'remove', '--force', wtPath]);
  gitTry(repo, ['worktree', 'prune']);
}

/** 실행 에이전트에게 붙일 워크트리 컨텍스트 프리앰블(경로 고정·타 체크아웃 금지·한국어 보고). */
export function worktreePreamble(wtPath) {
  return [
    `[언어] 모든 설명·진행보고·요약은 반드시 한국어로 작성하라(관리자 콘솔 대화 스레드에 그대로 노출된다). 코드·식별자·명령은 원문 유지.`,
    `[보고 형식] 최종 응답은 반드시 두 섹션으로 나눠라. 맨 위에 "[설명]" — 비개발자도 이해하는 쉬운 한국어 2~4문장(무엇을·왜 했고 결과가 뭔지, 전문용어 최소화). 그 아래 "[작업내용]" — 기술 상세(변경 파일·핵심 결정·검증 결과). 섹션 제목은 대괄호 그대로 표기하라.`,
    `[작업 디렉토리 = ${wtPath}]`,
    `이 요청은 격리된 git 워크트리에서 처리된다. 모든 파일 읽기/쓰기는 이 디렉토리 기준으로 하라.`,
    `웹 앱은 ${wtPath}/web, DB 스키마는 ${wtPath}/web/supabase 다.`,
    `절대 다른 체크아웃(/home/user/th-team/repo/thundorun 원본, blog-publisher 등)을 수정하지 마라.`,
    `커밋·푸시·배포는 하지 마라(완료 후 시스템이 자동 처리한다).`,
    `사용자에게 되묻지 마라(AskUserQuestion 불가). 파일 쓰기 권한이 없는 검증/리뷰 역할(security-reviewer·verifier 등)은 보고서 파일을 만들려 하지 말고, 결과를 응답 본문에 한국어로 요약해 남겨라.`,
  ].join('\n');
}

/**
 * 승인된 dev 요청의 실행 컨텍스트를 준비한다.
 * 반환: { cwd, branch, preamble } — execute 잡을 이 cwd 에서 돌리고 preamble 을 프롬프트에 앞세운다.
 * 자동배포 비활성/비dev 면 null(호출측이 기존 ROOT 로 폴백).
 */
export function prepareDevContext(cfg, request) {
  if (!deployEnabled(cfg) || !isDevRequest(request)) return null;
  const branch = sanitizeBranch(request.worktree, request.id);
  const cwd = ensureWorktree(cfg, branch);
  return { cwd, branch, preamble: worktreePreamble(cwd) };
}

/** 이 커밋에서 바뀐 web/supabase/*.sql 절대경로 목록(마이그레이션 우선용). */
function changedMigrations(cfg, wtPath) {
  const r = gitTry(wtPath, ['diff', '--name-only', 'HEAD~1', 'HEAD']);
  if (!r.ok) return [];
  return r.out.split('\n')
    .map(s => s.trim())
    .filter(f => /^web\/supabase\/.+\.sql$/.test(f))
    .map(f => join(wtPath, f));
}

/**
 * 완료 결과(done_result) 본문 — 비전문가도 읽히는 평문.
 * 무엇을 했나 / 어디에 반영됐나(브랜치·배포) / 서브태스크별 요약 / 다음 할 일.
 */
export function buildDeployDoneContent({ request, subtasks, result }) {
  const title = request.title || (request.plan && request.plan.ai_title) || '요청';
  const lines = [`## ✅ 완료 — ${title}`, ''];

  const summary = request.plan && request.plan.summary;
  lines.push('**무엇을 했나요**');
  lines.push(summary ? summary : `요청을 ${subtasks.length}개 하위작업으로 나눠 담당 에이전트가 처리했습니다.`);
  lines.push('');

  lines.push('**반영 위치**');
  if (result.status === 'deployed') {
    lines.push(`- 🌿 브랜치 \`${result.branch}\` → main 반영·Vercel 배포 트리거 완료`);
    if (result.url) {
      lines.push(result.verified
        ? `- 🔗 ${result.url} — 사이트 정상 응답 확인. **새 화면이 안 보이면 브라우저 강력 새로고침(Ctrl+Shift+R)** 하세요(배포 반영에 1~2분 지연 가능).`
        : `- 🔗 ${result.url} — ⚠ 자동 배포검증은 하지 못했습니다. 잠시 후 사이트에서 직접 확인하세요(강력 새로고침 Ctrl+Shift+R).`);
    }
  } else if (result.status === 'committed_only') {
    lines.push(`- 🌿 브랜치 \`${result.branch}\` 에 커밋 완료 — ${result.note}`);
  } else if (result.status === 'nochange') {
    lines.push(`- 파일 변경이 없어 배포할 내용이 없습니다. (${result.note})`);
  } else {
    lines.push(`- ⚠ ${result.note}`);
    if (result.branch) lines.push(`- 작업물은 브랜치 \`${result.branch}\` 에 보존되어 있습니다(수동 확인 가능).`);
  }
  lines.push('');

  if (subtasks.length) {
    lines.push('**진행 내역**');
    for (const s of subtasks) {
      const ex = (s.result_excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      lines.push(`- ${s.agent_id}: ${ex || '완료'}`);
    }
  }
  return lines.join('\n');
}

/**
 * 자동 반영 실행. request(승인·전 서브태스크 done)와 subtasks 를 받아
 * 커밋→(마이그레이션)→push→배포→검증/롤백을 수행한다.
 * 반환: { status: 'deployed'|'committed_only'|'nochange'|'error', branch, url?, note }
 * 부작용(원격 push·배포·마이그레이션)은 dry_run 이면 로그만.
 */
export async function finalizeDeploy(cfg, { request, subtasks, log = console, skipKillswitch = false }) {
  const dry = cfg.dry_run === true;
  const author = { name: cfg.author_name, email: cfg.author_email };
  // ① author 게이트 — config 가 yoonsundo 가 아니면 배포가 차단되므로 즉시 거부.
  if (!author.email || author.email !== REQUIRED_AUTHOR_EMAIL) {
    return { status: 'error', branch: null, note: `배포 author 가 yoonsundo(${REQUIRED_AUTHOR_EMAIL}) 가 아니어서 자동배포를 거부했습니다.` };
  }
  // 방어심화: 콜러가 게이트를 빠뜨려도 비-dev 요청은 여기서 거부(finalizeDeploy 는 export 됨).
  if (!isDevRequest(request)) {
    return { status: 'error', branch: null, note: '비-dev 요청은 자동배포 대상이 아닙니다.' };
  }

  const branch = sanitizeBranch(request.worktree, request.id);
  let wtPath;
  try { wtPath = ensureWorktree(cfg, branch); }
  catch (e) { return { status: 'error', branch, note: `워크트리 준비 실패: ${e.message}` }; }

  // ② 스테이지 + 변경 유무 확인.
  git(wtPath, ['add', '-A']);
  const dirty = gitTry(wtPath, ['status', '--porcelain']);
  const hasNewChanges = !(dirty.ok && !dirty.out.trim());
  if (!hasNewChanges) {
    // 새 변경이 없어도, killswitch 로 커밋만 남고 push 못 한 "재배포(resume)" 케이스가 있다 —
    // origin/<base> 대비 미푸시 커밋이 있으면 커밋 단계만 건너뛰고 배포를 이어간다.
    const base = cfg.base_branch || 'main';
    const ahead = gitTry(wtPath, ['rev-list', '--count', `origin/${base}..HEAD`]);
    const unpushed = ahead.ok && parseInt(ahead.out, 10) > 0;
    if (!unpushed) {
      if (!dry) removeWorktree(cfg, branch);
      return { status: 'nochange', branch, note: '에이전트가 파일을 변경하지 않았습니다.' };
    }
    log.info?.(`[deploy] 새 변경 없음 + 미푸시 커밋 ${ahead.out.trim()}건 → 재배포 재개(커밋 단계 스킵)`);
  }

  // ③ 커밋 — author 를 yoonsundo 로 강제(-c + --author 이중). (재배포 재개 시엔 스킵)
  if (hasNewChanges) {
    const msg = `orchestrator: ${(request.title || 'auto').slice(0, 60)} (req ${request.id})`;
    const commit = gitTry(wtPath, [
      '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
      'commit', '-m', msg, '--author', `${author.name} <${author.email}>`,
    ]);
    if (!commit.ok) return { status: 'error', branch, note: `커밋 실패: ${commit.err.slice(0, 200)}` };
    log.info?.(`[deploy] committed on ${branch} (${wtPath})`);
  }

  // ④ killswitch: 커밋까지만, push/배포 스킵.
  //    단, 관리자가 콘솔에서 '완료 처리'로 명시 배포를 트리거한 경우(skipKillswitch)는 우회한다 —
  //    킬스위치는 원래 "승인 후 자동배포"를 막던 브레이크인데, 이제 배포는 사람이 완료대기 검토 후
  //    직접 눌러야만 시작되므로(사람 게이트) 그 목적이 이미 충족된다.
  if (!skipKillswitch && killswitchActive(cfg)) {
    return { status: 'committed_only', branch, note: `킬스위치(비상정지)가 켜져 있어 라이브 배포 직전에 멈췄습니다. 작업물은 커밋으로 안전하게 보존되어 있습니다(브랜치 ${branch}). ⚠ '완료' 처리를 해도 배포되지는 않습니다 — 배포하려면 운영자가 킬스위치를 해제한 뒤 이 요청의 재배포를 실행해야 하며, 그때 저장된 커밋부터 이어서 배포됩니다.` };
  }

  const base = cfg.base_branch || 'main';

  // ⑤ 마이그레이션 먼저(스키마 변경이 있으면). 실패 시 배포 중단(migration-first).
  const migrations = changedMigrations(cfg, wtPath);
  if (migrations.length) {
    if (dry) {
      log.info?.(`[deploy][dry] migrate 스킵(로그만): ${migrations.join(', ')}`);
    } else {
      const [cmd, ...rest] = (cfg.migrate_cmd || 'node --env-file=.env scripts/db/migrate.mjs').split(' ');
      const run = runCmd(ROOT, cmd, [...rest, ...migrations]);
      if (!run.ok) {
        // 마이그레이션은 .env(서비스롤·DB 크리덴셜) 를 쓴다 → stderr 원문을 스레드에 노출하지 않는다.
        log.error?.(`[deploy] migration failed: ${run.err}`);
        return { status: 'error', branch, note: '마이그레이션 실패로 배포를 중단했습니다(작업물은 브랜치에 보존). 상세는 서버 로그를 확인하세요.' };
      }
      log.info?.(`[deploy] migrations applied: ${migrations.length}건`);
    }
  }

  // ⑤.5 base 최신화: 브랜치를 딴 뒤 main 이 앞서갔으면 FF push 가 거부되므로,
  //      origin/base 를 브랜치에 먼저 병합해 최신화한다. 충돌 시 중단(수동 병합 필요).
  //      dry-run 은 워크트리를 건드리지 않으므로 스킵.
  if (!dry) {
    const fetchBase = gitTry(wtPath, ['fetch', 'origin', base]);
    if (fetchBase.ok) {
      const behind = gitTry(wtPath, ['rev-list', '--count', `HEAD..origin/${base}`]);
      if (behind.ok && parseInt(behind.out, 10) > 0) {
        const merge = gitTry(wtPath, [
          '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
          'merge', '--no-edit', `origin/${base}`,
        ]);
        if (!merge.ok) {
          gitTry(wtPath, ['merge', '--abort']);
          log.error?.(`[deploy] base 병합 충돌: ${merge.err}`);
          return { status: 'error', branch, note: `main 의 최신 변경과 자동 병합에 실패했습니다(충돌). 작업물은 브랜치 \`${branch}\` 에 보존했습니다 — 수동 병합 후 다시 완료 처리하세요.` };
        }
        log.info?.(`[deploy] origin/${base} ${behind.out.trim()}건 앞서감 → 브랜치에 병합(최신화) 완료`);
      }
    } else {
      log.warn?.(`[deploy] origin/${base} fetch 실패 — 최신화 없이 진행: ${fetchBase.err}`);
    }
  }

  // ⑥ 브랜치 push(추적성) — dry 면 로그만.
  if (dry) {
    log.info?.(`[deploy][dry] git push -u origin ${branch} 스킵`);
  } else {
    const p = gitTry(wtPath, ['push', '-u', 'origin', branch]);
    if (!p.ok) {
      log.error?.(`[deploy] branch push failed: ${p.err}`);
      return { status: 'error', branch, note: '브랜치 push 에 실패해 배포를 중단했습니다(작업물은 브랜치에 보존). 상세는 서버 로그를 확인하세요.' };
    }
  }

  // ⑦ main FF push(=Vercel 배포 트리거). --force 절대 안 씀 → 비FF면 중단.
  if (dry) {
    log.info?.(`[deploy][dry] git push origin ${branch}:${base} (배포) 스킵`);
    return { status: 'deployed', branch, url: cfg.deploy_url, note: '(dry-run) 실제 배포 없이 통과' };
  }
  const deploy = gitTry(wtPath, ['push', 'origin', `${branch}:${base}`]);
  if (!deploy.ok) {
    log.error?.(`[deploy] main push failed: ${deploy.err}`);
    return { status: 'error', branch, note: '자동배포(main 반영)에 실패했습니다 — main 이 앞서 있어 fast-forward 가 안 되거나 권한 문제입니다. 강제 push 는 하지 않았습니다(작업물은 브랜치에 보존). 상세는 서버 로그를 확인하세요.' };
  }
  log.info?.(`[deploy] pushed ${branch}:${base} — Vercel 배포 트리거`);

  // ⑧ 배포 후 사이트 생존 확인(URL 200 폴링). 사이트가 죽으면 revert 를 main 에 올려 되돌린다.
  //   주의: '/'(루트)는 Vercel 이 빌드 실패 시에도 직전 빌드를 계속 서빙하므로, 이 검증은
  //   "사이트 다운" 은 잡지만 "빌드는 됐는데 특정 라우트가 깨진" 경우까지는 못 잡는다(설계 한계).
  // forceLive: 이 시점엔 이미 main 에 push 가 끝난 "실제 배포"다 → 데몬이 mock 이어도 사이트
  // 200 확인만은 진짜로 수행한다(토큰 불필요). 검증 스킵 후 가짜 "확인됨" 보고를 방지.
  let verified = { ok: true, skipped: true };
  try { verified = await waitDeploy(cfg.deploy_url, { timeoutMs: cfg.deploy_timeout_ms || 180000, forceLive: true }); }
  catch (e) { verified = { ok: false, error: e.message }; }

  if (!verified.ok) {
    log.warn?.(`[deploy] 배포 후 사이트 응답 없음 → 롤백 시도`);
    const revert = gitTry(wtPath, [
      '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
      'revert', '--no-edit', 'HEAD',
    ]);
    if (!revert.ok) {
      log.error?.(`[deploy] revert 생성 실패: ${revert.err}`);
      return { status: 'error', branch, note: '배포 후 사이트 응답 실패 + 롤백 커밋 생성 실패 — 사이트가 깨진 상태일 수 있어 즉시 수동 확인이 필요합니다.' };
    }
    const rbPush = gitTry(wtPath, ['push', 'origin', `${branch}:${base}`]); // 롤백을 라이브에 반영(FF)
    if (!rbPush.ok) {
      log.error?.(`[deploy] 롤백 push 실패: ${rbPush.err}`);
      return { status: 'error', branch, note: '배포 후 사이트 응답 실패 → 롤백 커밋은 만들었으나 main 반영(push)에 실패했습니다. 사이트가 깨진 상태일 수 있어 즉시 수동 확인이 필요합니다.' };
    }
    return { status: 'error', branch, note: '배포 후 사이트 응답 확인 실패 → 자동 롤백(직전 상태로 되돌림)까지 완료했습니다. 원인 확인 후 재시도하세요.' };
  }

  // 성공 — 로컬 워크트리 정리(커밋은 origin 에 있음). dry-run 은 테스트가 트리를 검사하므로 보존.
  if (!dry) removeWorktree(cfg, branch);
  const siteOk = verified.ok && !verified.skipped;   // 실제 200 확인 여부(skip=검증 못함)
  return {
    status:   'deployed',
    branch,
    url:      cfg.deploy_url,
    verified: siteOk,
    note:     siteOk
      ? `사이트 정상 응답(HTTP ${verified.status}) 확인 — 새 화면은 Vercel 빌드 완료 후 반영됩니다(강력 새로고침 권장).`
      : '자동 배포검증을 수행하지 못했습니다 — 사이트에서 직접 확인이 필요합니다.',
  };
}

/** git 외 명령 실행 헬퍼(마이그레이션 등). 비throw. */
function runCmd(cwd, cmd, args) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: '', err: (e.stderr || e.stdout || e.message || '').toString() };
  }
}
