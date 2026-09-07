#!/usr/bin/env node
/**
 * scripts/test/smoke.mjs — 간이 스모크 테스트
 *
 * 검증 항목:
 *   1. 게이트 전종이 샘플 초안에 대해 동작 (exit 0 or 1, not 2)
 *   2. run-all-gates 통합 실행 (JSON 출력 스키마 확인)
 *   3. run-lion mock 1회 성공 (발행 >= 1, 오류 0)
 *   4. audit verify-chain 무결성 ok
 *
 * 격리: budget 상태를 테스트 전후로 저장/복원 → 일일 누적 캡 간섭 없음.
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패
 */

import { execFile }      from 'node:child_process';
import { promisify }     from 'node:util';
import {
  writeFileSync, readFileSync, mkdirSync,
  existsSync, rmSync, copyFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChain }   from '../audit/verify-chain.mjs';

const execFileAsync = promisify(execFile);

const __filename  = fileURLToPath(import.meta.url);
const TEST_DIR    = dirname(__filename);
const SCRIPTS_DIR = resolve(TEST_DIR, '..');
const ROOT_DIR    = resolve(SCRIPTS_DIR, '..');

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function pass(label) {
  console.log(`  [PASS] ${label}`);
  passCount++;
}

function fail(label, detail = '') {
  console.error(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`);
  failCount++;
}

async function runNode(scriptPath, args = [], env = {}) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [scriptPath, ...args],
      {
        // 300s — run-lion mock 이 실측 ~185s 로 늘어나 기존 180s 상한에 스치면서
        // "run-lion mock: exit 1" 거짓 실패가 났다(2026-07-30). 직접 실행 시 발행 3·오류 0 정상.
        timeout: 300_000,
        env:     { ...process.env, ...env },
      }
    );
    return { exit: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (e) {
    // 타임아웃은 실패와 구별해서 드러낸다 — execFile 은 kill 시 code 대신 signal 을 채우므로
    // `e.code ?? 1` 만 보면 "느려서 죽은 것"이 "테스트가 틀린 것"으로 보고돼 원인을 못 찾는다.
    const timedOut = e.killed === true || e.signal != null;
    return {
      exit:    timedOut ? 'TIMEOUT' : (e.code ?? 1),
      timedOut,
      stdout:  e.stdout ?? '',
      stderr:  e.stderr ?? '',
    };
  }
}

// ─── 상태 저장/복원 ──────────────────────────────────────────────────────────
// 스모크 테스트 내 run-lion 실행이 published-index·예산에 간섭하지 않도록 격리.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function budgetPath() {
  return join(ROOT_DIR, 'runs', todayStr(), 'budget.json');
}

function publishedIndexPath() {
  return join(ROOT_DIR, 'state', 'published-index.json');
}

function snapshotFile(p) {
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function restoreFile(p, snapshot) {
  if (snapshot === null) return;
  try { writeFileSync(p, snapshot, 'utf8'); } catch { /* 복원 실패 무시 */ }
}

function resetBudgetForTest() {
  const p   = budgetPath();
  const dir = join(ROOT_DIR, 'runs', todayStr());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fresh = {
    date:         todayStr(),
    tokens_used:  0,
    calls_used:   0,
    events:       [],
    created_at:   new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    _smoke_reset: true,
  };
  writeFileSync(p, JSON.stringify(fresh, null, 2), 'utf8');
}

function resetPublishedIndexForTest() {
  // 빈 인덱스로 초기화 → 모든 주제가 fresh로 인식됨
  writeFileSync(publishedIndexPath(), '{}', 'utf8');
}

// ─── 샘플 초안 생성 ───────────────────────────────────────────────────────────

function makeSampleDraft() {
  const dir = join(ROOT_DIR, '.smoke-tmp');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // 한글 음절 1500~2000 범위를 만족하는 충분한 본문
  const para = [
    '준비 단계에서 가장 먼저 해야 할 일은 환경 설정을 꼼꼼히 확인하는 것입니다. 설치 전에 시스템 요구사항을 확인하고, 필요한 의존성 패키지를 미리 설치해두면 나중에 겪는 오류를 상당 부분 줄일 수 있습니다.',
    '단계별 설정을 진행할 때는 공식 문서를 옆에 열어두고 따라가는 것을 권장합니다. 처음에는 모든 옵션을 건드리지 말고 기본값으로 시작하세요. 기본 설정으로도 대부분의 기능이 작동하며, 이후 필요에 따라 조금씩 커스터마이징하면 됩니다.',
    '테스트는 반드시 작은 단위부터 시작해야 합니다. 전체 워크플로우를 한 번에 실행하기 전에 각 단계가 개별적으로 정상 동작하는지 먼저 확인하세요. 이렇게 하면 문제가 생겼을 때 원인을 훨씬 빠르게 찾을 수 있습니다.',
    '로그 파일은 문제 해결의 핵심 단서입니다. 오류가 발생했을 때 당황하지 말고 로그를 천천히 읽어보세요. 대부분의 오류 메시지에는 문제의 원인과 해결 방향이 함께 담겨 있습니다.',
    '설정 완료 후에는 간단한 동작 확인 테스트를 실행해보세요. 실제 데이터 대신 샘플 데이터로 먼저 테스트하면 실수로 인한 피해를 최소화할 수 있습니다.',
    '운영 환경에 적용하기 전에 스테이징 환경에서 충분히 검증하는 단계를 반드시 거치세요. 운영 환경과 동일한 조건에서 테스트해야 나중에 예상치 못한 문제를 예방할 수 있습니다.',
    '정기적인 백업 설정도 잊지 마세요. 중요한 설정 파일과 데이터는 자동 백업이 되도록 구성해두면 문제가 생겼을 때 빠르게 복구할 수 있습니다.',
    '이 가이드를 통해 기본 설정은 완료되었을 것입니다. 이제 자신의 환경에 맞게 조금씩 최적화해 나가면 됩니다. 커뮤니티 포럼에서 다른 사용자들의 경험을 참고하면 더 빠르게 발전할 수 있습니다.',
    '마지막으로, 공식 변경 로그와 릴리즈 노트를 주기적으로 확인하는 습관을 들이세요. 새로운 기능과 버그 수정 내용을 미리 파악해두면 업그레이드 시 충돌을 예방할 수 있습니다.',
    '처음부터 완벽하게 구축하려 하지 마세요. 작동하는 최소 구성에서 시작해 문제를 하나씩 해결해 나가는 방식이 훨씬 효율적입니다. 반복 개선이 장기적으로 더 좋은 결과를 만듭니다.',
    '같은 팀원과 설정을 공유할 때는 환경 변수나 비밀 키를 직접 공유하지 말고 시크릿 관리 도구를 활용하세요. 보안 사고 예방과 협업 효율 모두를 잡을 수 있는 방법입니다.',
  ].join('\n\n');

  const content = [
    '---',
    'id: draft-smoke001',
    'topic_id: topic-smoke001',
    'outline_id: outline-smoke001',
    'writer: beaver',
    'slug: post-smoke001',
    'title: "Claude Code 자동화 스모크 테스트 가이드"',
    'char_count: 1600',
    'status: draft',
    'attempt: 0',
    'created_at: "' + new Date().toISOString() + '"',
    '---',
    '',
    '# Claude Code 자동화 스모크 테스트 가이드',
    '',
    '이 글은 스모크 테스트용 샘플 초안입니다.',
    '',
    '## 환경 준비',
    '',
    para,
    '',
    '## 단계별 설정',
    '',
    '위 단계를 차례로 따라가면 기본 환경이 완성됩니다. 이후 추가 설정은 공식 문서를 참고하면서 하나씩 진행하시면 됩니다. 커뮤니티 포럼에서 비슷한 사례를 찾아보는 것도 좋은 방법입니다. 시간을 들여 천천히 구성하면 나중에 겪을 문제를 크게 줄일 수 있습니다.',
    '',
    '## 정리',
    '',
    '지금까지 살펴본 내용을 바탕으로 자신만의 환경을 구성해 보세요. 작은 시작이 큰 변화를 만듭니다. 꾸준히 개선해 나가다 보면 어느새 전문가 수준의 환경을 갖추게 될 것입니다.',
    '',
  ].join('\n');

  const filepath = join(dir, 'smoke-draft.md');
  writeFileSync(filepath, content, 'utf8');
  return filepath;
}

// ─── 테스트 1: 게이트 동작 확인 ─────────────────────────────────────────────

/**
 * run-all-gates 가 돌려야 할 게이트 수.
 * 게이트를 늘리면 여기와 아래 GATES 목록 둘 다 고친다 — 개수만 맞고 목록이 안 늘면
 * 새 게이트가 스모크에서 조용히 빠진다(거짓 green).
 */
const EXPECTED_GATE_COUNT = 17;

async function testGates(samplePath) {
  console.log(`\n[1] 게이트 ${EXPECTED_GATE_COUNT}종 동작 테스트`);

  const gates = [
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
    'check-source-fidelity.mjs',
    'check-firsthand.mjs',
  ];

  for (const gate of gates) {
    const scriptPath = join(SCRIPTS_DIR, 'gates', gate);
    const r = await runNode(scriptPath, [samplePath], { RUN_MODE: 'mock' });

    // exit 2 = 실행 오류 (용납 안 됨). exit 0/1은 통과/실패로 정상 동작.
    if (r.exit === 2) {
      fail(`gate ${gate}`, `exit 2 (실행 오류)\nstderr: ${r.stderr.slice(0, 200)}`);
      continue;
    }

    // stdout에 JSON 있는지 확인
    const firstJson = r.stdout.split('\n').find(l => l.trim().startsWith('{'));
    if (!firstJson) {
      fail(`gate ${gate}`, `JSON 출력 없음 (exit ${r.exit})\nstdout: ${r.stdout.slice(0, 100)}`);
      continue;
    }

    try {
      const result = JSON.parse(firstJson);
      if (typeof result.pass !== 'boolean' || !result.gate) {
        fail(`gate ${gate}`, `출력 스키마 불완전: ${firstJson.slice(0, 100)}`);
      } else {
        pass(`gate ${gate} → ${result.pass ? 'PASS' : 'FAIL'} (exit ${r.exit})`);
      }
    } catch {
      fail(`gate ${gate}`, `JSON 파싱 오류: ${firstJson.slice(0, 100)}`);
    }
  }
}

// ─── 테스트 2: run-all-gates 통합 실행 ───────────────────────────────────────

async function testRunAllGates(samplePath) {
  console.log('\n[2] run-all-gates 통합 테스트');

  const scriptPath = join(SCRIPTS_DIR, 'gates', 'run-all-gates.mjs');
  const r = await runNode(scriptPath, [samplePath], { RUN_MODE: 'mock' });

  if (r.exit === 2) {
    fail('run-all-gates', `exit 2 (실행 오류)\nstderr: ${r.stderr.slice(0, 300)}`);
    return;
  }

  const firstJson = r.stdout.split('\n').find(l => l.trim().startsWith('{'));
  if (!firstJson) {
    fail('run-all-gates', `JSON 출력 없음\nstdout: ${r.stdout.slice(0, 200)}`);
    return;
  }

  try {
    const result = JSON.parse(firstJson);
    if (typeof result.all_pass !== 'boolean') {
      fail('run-all-gates', 'all_pass 필드 없음');
    } else if (!Array.isArray(result.gates) || result.gates.length !== EXPECTED_GATE_COUNT) {
      fail('run-all-gates', `게이트 수 이상: ${result.gates?.length}`);
    } else {
      pass(`run-all-gates → all_pass=${result.all_pass}, gates=${result.gates.length}개`);
    }
  } catch (e) {
    fail('run-all-gates', `JSON 파싱 오류: ${e.message}`);
  }
}

// ─── 테스트 3: run-lion mock 1회 실행 ────────────────────────────────────────
// 예산·published-index 상태를 저장·초기화 후 실행, 완료 후 복원.

async function testRunLionMock() {
  console.log('\n[3] run-lion mock 1회 실행 테스트');

  // 상태 저장 → 초기화 (일일 캡·dedup 간섭 방지)
  const budgetSnap  = snapshotFile(budgetPath());
  const indexSnap   = snapshotFile(publishedIndexPath());
  resetBudgetForTest();
  resetPublishedIndexForTest();

  // mock 격리 디렉토리 정리 — 같은 날짜에 mock 런이 누적되면
  // budget 캡 도달·topic-history 고갈로 발행 0건이 되는 구조적 간섭 제거
  rmSync(join(ROOT_DIR, '.mock-out'), { recursive: true, force: true });

  const scriptPath = join(SCRIPTS_DIR, 'run-lion.mjs');
  let r;
  try {
    r = await runNode(scriptPath, [], { RUN_MODE: 'mock' });
  } finally {
    // 상태 복원
    restoreFile(budgetPath(), budgetSnap);
    restoreFile(publishedIndexPath(), indexSnap);
  }

  if (r.exit !== 0) {
    fail('run-lion mock', `exit ${r.exit}\nstderr: ${r.stderr.slice(0, 300)}`);
    return;
  }

  const publishedMatch = r.stdout.match(/발행:(\d+)/);
  const errorsMatch    = r.stdout.match(/오류:(\d+)/);
  const published = publishedMatch ? parseInt(publishedMatch[1], 10) : -1;
  const errors    = errorsMatch    ? parseInt(errorsMatch[1], 10)    : -1;

  if (published < 1) {
    fail('run-lion mock', `발행 0건 (published=${published})\nstdout tail: ${r.stdout.slice(-300)}`);
  } else if (errors > 0) {
    fail('run-lion mock', `오류 ${errors}건 발생`);
  } else {
    pass(`run-lion mock → 발행 ${published}건, 오류 ${errors}건`);
  }
}

// ─── 테스트 4: audit verify-chain ────────────────────────────────────────────

async function testAuditVerifyChain() {
  console.log('\n[4] audit verify-chain 무결성 테스트');

  try {
    const result = await verifyChain();
    if (!result.ok) {
      fail('verify-chain', `체인 파손 — ${result.errors.length}개 오류:\n` +
        result.errors.slice(0, 3).map(e => `  ${e.error}`).join('\n'));
    } else {
      pass(`verify-chain → 정상 (${result.entries_checked}개 항목 확인)`);
    }
  } catch (err) {
    fail('verify-chain', `예외 발생: ${err.message}`);
  }
}

// ─── 정리 ─────────────────────────────────────────────────────────────────────

function cleanup() {
  try {
    const dir = join(ROOT_DIR, '.smoke-tmp');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // 정리 실패는 무시
  }
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== smoke.mjs 스모크 테스트 시작 ===');

  let samplePath;
  try {
    samplePath = makeSampleDraft();
  } catch (err) {
    console.error('[FATAL] 샘플 초안 생성 실패:', err.message);
    process.exit(1);
  }

  try {
    await testGates(samplePath);
    await testRunAllGates(samplePath);
    await testRunLionMock();
    await testAuditVerifyChain();
  } finally {
    cleanup();
  }

  console.log(`\n=== 결과: ${passCount}/${passCount + failCount} 통과 ===`);

  if (failCount > 0) {
    console.error(`[FAIL] ${failCount}개 항목 실패`);
    process.exit(1);
  }

  console.log('[PASS] 전체 스모크 테스트 통과');
  process.exit(0);
}

main().catch(err => {
  console.error('[FATAL] 스모크 테스트 예외:', err.message);
  process.exit(1);
});
