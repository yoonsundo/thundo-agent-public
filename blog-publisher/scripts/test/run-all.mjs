#!/usr/bin/env node
/**
 * scripts/test/run-all.mjs — 테스트 아그리게이터
 *
 * package.json 의 `test:*` 스크립트 중 **리프**(다른 test:* 를 조합하지 않는 것)를
 * 전부 찾아 순차 실행하고 결과를 집계한다.
 *
 * 왜 순차인가: 테스트들이 state/·runs/·budget 을 공유한다. 병렬로 돌리면
 * 서로의 상태를 밟아 거짓 red 가 난다(실측 이력 있음). 속도보다 판정 신뢰가 우선.
 *
 * 왜 아그리게이터가 필요한가: 이 저장소에는 `npm test` 가 없었고, 회귀 검증이
 * "사람이 45개 중 관련된 걸 골라 실행한다"에 의존했다.
 *
 * 입력: 없음 (플래그는 아래)
 * 출력: 사람이 읽는 요약 (stdout) / --json 이면 결과 JSON 1줄
 * exit: 0=전부 통과 / 1=하나라도 실패 / 2=실행오류
 *
 * 플래그:
 *   --list            실행하지 않고 대상 목록만 출력
 *   --only=<substr>   이름에 substr 이 포함된 것만 실행 (쉼표로 여러 개)
 *   --skip=<substr>   이름에 substr 이 포함된 것을 제외 (쉼표로 여러 개)
 *   --include-slow    SLOW 로 표시된 장시간 테스트도 실행 (기본 제외)
 *   --json            결과를 JSON 1줄로 stdout 출력
 *   --json-out=<path> 사람이 읽는 요약은 그대로 두고 결과 JSON 을 파일로 기록
 *                     (CI 에서 스위트를 두 번 돌리지 않으려고 있다)
 *   --bail            첫 실패에서 중단
 */
import { spawn }        from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir     = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = resolve(__dir, '../../');
const PKG_PATH  = join(ROOT_DIR, 'package.json');

// ─── 정책: 아그리게이터가 실행하지 않는 것 ───────────────────────────────────
// deny 가 아니라 **명시적 목록**이다. 조용히 빠지는 테스트가 없도록 이유를 붙이고,
// 실행 결과 요약에도 "제외 N건"으로 반드시 보고한다(거짓 green 방지).

/** 다른 test:* 를 조합하기만 하는 상위 스크립트 — 리프를 직접 돌므로 중복 실행 방지 */
const COMPOSITE = new Set(['test:curiosity', 'test:cardnews', 'test:security']);

/** 장시간 테스트: 기본 제외, --include-slow 로 포함. 값 = 타임아웃(ms) */
const SLOW = new Map([
  // 2026-08-21 F-17 해소 후 smoke 는 9초다(그전 309초). SLOW 목록은 비어 있지만
  // 구조는 남긴다 — 다시 느려지는 테스트가 생기면 여기 등록한다.
]);

/** SLOW 에 없는 테스트의 기본 타임아웃. smoke 는 여유를 두려고 별도로 잡는다. */
const SMOKE_TIMEOUT_MS = 600_000;

/**
 * 항상 제외 + 이유.
 *
 * 여기 들어가면 CI 판정에서 빠진다. 그래서 두 가지를 지킨다.
 *   1) 이유를 문장으로 적는다. "flaky" 같은 라벨은 금지 — 무엇이 왜 깨졌는지 적는다.
 *   2) 실행할 때마다 "제외 N건: 이름(이유)" 를 **항상** 출력한다(reportHuman 참조).
 *      조용히 빠지면 "다 통과" 로 오독되고, 그게 이 저장소의 반복 사고였다.
 *
 * 제외는 임시 조치다. 원인이 해소되면 즉시 지운다.
 */
const EXCLUDED = new Map([
]);

const DEFAULT_TIMEOUT_MS = 180_000;

// ─── 대상 수집 ────────────────────────────────────────────────────────────────

function loadScripts() {
  try {
    return JSON.parse(readFileSync(PKG_PATH, 'utf8')).scripts ?? {};
  } catch (e) {
    process.stderr.write(`run-all: package.json 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }
}

/**
 * 실행 대상 목록을 만든다.
 * `test:` 접두 스크립트 + SLOW 에 등록된 비접두 스크립트(smoke 등)를 포함한다.
 */
function collectTargets(scripts) {
  const names = Object.keys(scripts)
    .filter(n => n.startsWith('test:') || SLOW.has(n) || n === 'smoke')
    .filter(n => !COMPOSITE.has(n))
    // 자기 자신(run-all.mjs 를 부르는 스크립트)은 제외 — 아니면 무한 재귀다
    .filter(n => !String(scripts[n]).includes('run-all.mjs'))
    .sort();

  return names.map(name => ({
    name,
    command:   scripts[name],
    slow:      SLOW.has(name),
    timeoutMs: SLOW.get(name) ?? (name === 'smoke' ? SMOKE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    excluded:  EXCLUDED.get(name) ?? null,
  }));
}

// ─── 실행 ─────────────────────────────────────────────────────────────────────

/**
 * npm 스크립트 하나를 실행한다.
 * 종료코드를 **삼키지 않는다** — `|| echo` 로 127(미실행)이 성공으로 둔갑하는
 * 패턴이 이 저장소의 반복 사고였다.
 */
function runOne(target) {
  return new Promise(resolveRun => {
    const startedAt = Date.now();
    const child = spawn('npm', ['run', '--silent', target.name], {
      cwd:   ROOT_DIR,
      env:   process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, target.timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      clearTimeout(timer);
      resolveRun({
        ...target, ok: false, exitCode: null, spawnError: err.message,
        durationMs: Date.now() - startedAt, stdout, stderr, timedOut: false,
      });
    });

    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({
        ...target,
        ok:         code === 0 && !timedOut,
        exitCode:   code,
        spawnError: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout, stderr,
      });
    });
  });
}

// ─── 출력 ─────────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', YEL = '\x1b[33m', RST = '\x1b[0m';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? code + s + RST : s);

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 실패한 테스트의 출력 꼬리 — 실패 원인을 찾으려고 다시 실행하지 않아도 되게 */
function failureTail(r, lines = 25) {
  const combined = `${r.stdout}${r.stderr}`.trimEnd().split('\n');
  return combined.slice(-lines).map(l => `      ${l}`).join('\n');
}

function reportHuman(results, excluded, skipped) {
  const failed = results.filter(r => !r.ok);
  const passed = results.filter(r => r.ok);

  if (failed.length) {
    process.stdout.write(`\n${c(RED, '실패 상세')}\n`);
    for (const r of failed) {
      const why = r.timedOut     ? `타임아웃 ${fmtMs(r.timeoutMs)} 초과`
                : r.spawnError   ? `실행 실패: ${r.spawnError}`
                : `exit ${r.exitCode}`;
      process.stdout.write(`\n  ${c(RED, '✗')} ${r.name} — ${why}\n${failureTail(r)}\n`);
    }
  }

  const total = results.length;
  process.stdout.write(`\n${'─'.repeat(64)}\n`);
  process.stdout.write(
    `  ${c(GREEN, `통과 ${passed.length}`)} / ${failed.length ? c(RED, `실패 ${failed.length}`) : '실패 0'} / 전체 ${total}\n`
  );
  // 제외·건너뜀은 **항상** 보고한다 — 조용히 빠지면 "다 통과"로 오독된다.
  if (excluded.length) {
    process.stdout.write(`  ${c(YEL, `제외 ${excluded.length}`)}: ${excluded.map(e => `${e.name}(${e.excluded})`).join(', ')}\n`);
  }
  if (skipped.length) {
    process.stdout.write(`  ${c(DIM, `건너뜀 ${skipped.length}`)}: ${skipped.map(s => s.name).join(', ')}\n`);
  }
  process.stdout.write(`${'─'.repeat(64)}\n`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(n);
  /** `--flag=a,b,c` → ['a','b','c'] (목록용) */
  const list = n => {
    const hit = argv.find(a => a.startsWith(`${n}=`));
    return hit ? hit.slice(n.length + 1).split(',').filter(Boolean) : [];
  };
  /** `--flag=값` → '값' (단일값용 — 경로에 쉼표가 있어도 자르지 않는다) */
  const one = n => {
    const hit = argv.find(a => a.startsWith(`${n}=`));
    return hit ? hit.slice(n.length + 1) || null : null;
  };

  const asJson      = flag('--json');
  const jsonOut     = one('--json-out');
  const includeSlow = flag('--include-slow');
  const bail        = flag('--bail');
  const only        = list('--only');
  const skip        = list('--skip');

  const all = collectTargets(loadScripts());

  const excluded = all.filter(t => t.excluded);
  const runnable = all.filter(t => !t.excluded);

  const skipped = runnable.filter(t =>
    (only.length && !only.some(p => t.name.includes(p))) ||
    skip.some(p => t.name.includes(p)) ||
    (t.slow && !includeSlow)
  );
  const skipSet = new Set(skipped.map(t => t.name));
  const targets = runnable.filter(t => !skipSet.has(t.name));

  if (flag('--list')) {
    for (const t of all) {
      const mark = t.excluded ? `제외(${t.excluded})` : t.slow ? 'SLOW' : '';
      process.stdout.write(`${t.name.padEnd(38)}${mark}\n`);
    }
    process.exit(0);
  }

  // 필터를 줬는데 대상이 0건이면 **exit 2**. 그냥 두면 "통과 0 / 실패 0 / exit 0" 이
  // 되어 오타 하나가 "전부 통과" 로 읽힌다 — 이 러너가 막으려는 바로 그 패턴이다.
  if (targets.length === 0) {
    const filtered = only.length || skip.length;
    process.stderr.write(
      filtered
        ? `run-all: 필터에 걸린 테스트가 없다 (--only=${only.join(',') || '-'} --skip=${skip.join(',') || '-'}). ` +
          `대상 이름은 --list 로 확인하라.\n`
        : 'run-all: 실행할 테스트가 없다. package.json 의 test:* 스크립트를 확인하라.\n'
    );
    process.exit(2);
  }

  if (!asJson) {
    process.stdout.write(
      `테스트 ${targets.length}건 순차 실행` +
      `${skipped.length ? ` (건너뜀 ${skipped.length})` : ''}` +
      `${excluded.length ? ` (제외 ${excluded.length})` : ''}\n\n`
    );
  }

  const results = [];
  for (const t of targets) {
    if (!asJson) process.stdout.write(`  ${c(DIM, '·')} ${t.name.padEnd(38)}`);
    const r = await runOne(t);
    results.push(r);
    if (!asJson) {
      process.stdout.write(
        `${r.ok ? c(GREEN, 'PASS') : c(RED, 'FAIL')} ${c(DIM, fmtMs(r.durationMs))}\n`
      );
    }
    if (bail && !r.ok) break;
  }

  const payload = {
    ranAt:    new Date().toISOString(),
    total:    results.length,
    passed:   results.filter(r => r.ok).length,
    failed:   results.filter(r => !r.ok).length,
    excluded: excluded.map(e => ({ name: e.name, reason: e.excluded })),
    skipped:  skipped.map(s => s.name),
    results:  results.map(r => ({
      name: r.name, ok: r.ok, exitCode: r.exitCode,
      timedOut: r.timedOut, durationMs: r.durationMs,
      tail: r.ok ? null : failureTail(r, 12).trim(),
    })),
  };

  if (asJson) process.stdout.write(JSON.stringify(payload) + '\n');
  else        reportHuman(results, excluded, skipped);

  // 사람이 읽는 요약과 별개로 파일에도 남긴다. 기록 하나 얻자고 스위트를
  // 두 번 돌리는 낭비를 없애려는 것.
  if (jsonOut) {
    try {
      writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(`run-all: --json-out 기록 실패(${jsonOut}): ${e.message}\n`);
    }
  }

  process.exit(results.some(r => !r.ok) ? 1 : 0);
}

main().catch(e => {
  process.stderr.write(`run-all: 실행오류: ${e.stack ?? e.message}\n`);
  process.exit(2);
});
