#!/usr/bin/env node
/**
 * run-all-gates.mjs — 게이트 실행 & 결과 집계
 * dup → length → banned → lint → links → empty → ai-tells → sources →
 * credibility → density → hedge → internal-dup → niche → render-fit → seo → source-fidelity →
 * firsthand
 * (build/deploy는 별도 인자 필요해 run-all에서 제외, 직접 호출)
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄 {all_pass, gates:[GateResult], evidence:{git_sha,build_hash,url_status}}
 * exit: 0=전부 통과 / 1=하나라도 실패 / 2=실행오류
 *
 * 2026-08-21(F-07): 게이트 16종(현재 17종)을 **node 프로세스로 각각 spawn** 하던 것을 함수 호출로 바꿨다.
 * 프로세스를 함수 단위로 쓰는 것이 이 저장소에서 가장 비싼 복잡성이었다 — 게이트 하나를
 * 부르려고 spawn·stdout 파싱·exit 해석·타임아웃 관리·JSON 파싱 실패 처리가 필요했고,
 * 각 프로세스가 `config/pipeline.json` 을 다시 읽느라 **설정이 JSON 과 코드 두 곳에** 있었다.
 *
 * 각 게이트는 이제 `evaluate(draftPath)` 를 export 하고 CLI 껍데기는 `lib/gate-cli.mjs` 가
 * 맡는다. **외부 계약(stdout JSON 1줄 + exit 0/1/2)은 그대로**라 `npm run gate`·셸·크론이
 * 하나도 바뀌지 않는다. 변환 전후 16개 게이트의 CLI 출력이 바이트 동일함을 확인했다.
 *
 * ⚠ 프로세스 격리가 사라졌으므로 **게이트 하나의 예외가 전체를 죽이면 안 된다** —
 *   게이트별 try/catch 로 감싸 기존의 "exit 2 → 판정 실패" 와 같은 모양을 유지한다.
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluate as dup }            from './check-dup.mjs';
import { evaluate as length }         from './check-length.mjs';
import { evaluate as banned }         from './check-banned.mjs';
import { evaluate as lint }           from './check-lint.mjs';
import { evaluate as links }          from './check-links.mjs';
import { evaluate as empty }          from './check-empty.mjs';
import { evaluate as aiTells }        from './check-ai-tells.mjs';
import { evaluate as sources }        from './check-sources.mjs';
import { evaluate as credibility }    from './check-credibility.mjs';
import { evaluate as density }        from './check-density.mjs';
import { evaluate as hedge }          from './check-hedge.mjs';
import { evaluate as internalDup }    from './check-internal-dup.mjs';
import { evaluate as niche }          from './check-niche.mjs';
import { evaluate as renderFit }      from './check-render-fit.mjs';
import { evaluate as seo }            from './check-seo.mjs';
import { evaluate as sourceFidelity } from './check-source-fidelity.mjs';
import { evaluate as firsthand }      from './check-firsthand.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));

/** 실행 순서는 기존 GATE_SCRIPTS 와 동일하다(결과 배열 순서가 계약의 일부다). */
const GATES = [
  ['dup',             dup],
  ['length',          length],
  ['banned',          banned],
  ['lint',            lint],
  ['links',           links],
  ['empty',           empty],
  ['ai-tells',        aiTells],
  ['sources',         sources],
  ['credibility',     credibility],
  ['density',         density],
  ['hedge',           hedge],
  ['internal-dup',    internalDup],
  ['niche',           niche],
  ['render-fit',      renderFit],
  ['seo',             seo],
  ['source-fidelity', sourceFidelity],   // S3a shadow 기본 (config/source-pack.json gate_enforce)
  // 맨 뒤에 붙인다 — 결과 배열 순서가 계약이라 기존 16개의 인덱스를 밀면 안 된다.
  ['firsthand',       firsthand],        // 조작된 1인칭 실행 주장 (2026-09-07 신설)
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

/**
 * 단일 게이트 실행 → GateResult.
 * 예외는 판정 실패로 바꾼다 — 프로세스 격리가 없어졌으므로 여기서 막지 않으면
 * 게이트 하나가 전체 런을 죽인다(그러면 초안 전량이 조용히 폐기된다).
 */
async function runGate(gateName, evaluate, draftPath) {
  try {
    const result = await evaluate(draftPath);
    if (!result || typeof result.pass !== 'boolean') {
      return {
        gate: gateName,
        pass: false,
        reason: '게이트가 판정을 돌려주지 않음',
        evidence: { raw_output: String(result).slice(0, 200) },
      };
    }
    return result;
  } catch (e) {
    process.stderr.write(`[${gateName}] ${e.message}\n`);
    return {
      gate: gateName,
      pass: false,
      reason: `게이트 실행오류: ${e.message}`,
      evidence: { raw_output: String(e.stack ?? e.message).slice(0, 200) },
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
  for (const [name, evaluate] of GATES) {
    process.stderr.write(`>> 게이트 실행: check-${name}.mjs\n`);
    const gateResult = await runGate(name, evaluate, absDraft);
    gates.push(gateResult);
    process.stderr.write(`   ${gateResult.pass ? 'PASS' : 'FAIL'} — ${gateResult.reason ?? ''}\n`);
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
