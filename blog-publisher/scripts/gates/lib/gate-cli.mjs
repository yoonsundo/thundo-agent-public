/**
 * gates/lib/gate-cli.mjs — 게이트의 CLI 껍데기 (F-07)
 *
 * 게이트는 원래 "프로세스를 함수 단위로" 쓰고 있었다. `run-all-gates` 가 16개 게이트를
 * 각각 node 프로세스로 spawn 하고, 각 프로세스가 `config/pipeline.json` 을 **다시 읽고**,
 * 읽기에 실패할 때를 대비해 기본값을 코드에 인라인으로 들고 있었다
 * (`check-length` 의 `catch { return { length: { min: 1500, max: 2000 } } }`).
 * 그래서 **발행 길이 기준 같은 핵심 정책이 JSON 과 코드 두 곳에 존재**했다.
 *
 * 여기서는 판정(`evaluate`)과 껍데기(CLI)를 나눈다.
 *   - `evaluate(draftPath, ctx)` — 값을 돌려주거나 `GateError` 를 던진다. 테스트 가능.
 *   - `runGateCli(...)`          — stdout JSON 1줄 + exit 0/1/2 계약을 그대로 유지.
 *
 * **외부에서 본 동작은 완전히 동일하다.** `npm run gate`·셸 스크립트·크론이 그대로 돈다.
 * 달라지는 것은 `run-all-gates` 가 spawn 대신 함수를 부를 수 있게 된다는 점뿐이다.
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 실행오류(exit 2). 판정 실패(exit 1)와 구분한다 — 이 둘을 섞으면 사고가 조용해진다. */
export class GateError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'GateError';
    this.cause = cause;
  }
}


/** 설정 파일 경로는 항상 저장소 루트 기준이다 — 상대경로는 cwd 에 따라 조용히 빗나간다. */
const GATES_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(GATES_DIR, '../../../');

/**
 * 게이트 설정 로드. **실패하면 던진다.**
 *
 * 지금까지는 각 게이트가 읽기에 실패하면 코드에 인라인된 기본값으로 조용히 폴백했다
 * (`check-length` 의 `{ min: 1500, max: 2000 }`). 그래서 발행 길이 기준 같은 핵심 정책이
 * JSON 과 코드 **두 곳**에 존재했고, JSON 을 바꾼 뒤 파일이 손상되면 게이트가 실패를
 * 알리는 대신 **옛 기준으로 통과시켰다** — exit 2 로 드러나야 할 상황이 exit 0/1 로 위장된다.
 *
 * 던지면 CLI 껍데기가 exit 2 로 바꾸고, run-all-gates 는 판정 실패로 집계한다.
 * 초안은 폐기되지만 **잘못된 기준으로 발행되지는 않는다** — 실패 방향이 안전한 쪽이다.
 *
 * @param {string} [name='pipeline.json'] config/ 아래 파일명
 */
export function loadGateConfig(readFileSync, name = 'pipeline.json') {
  const path = join(REPO_ROOT, 'config', name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new GateError(`설정 읽기 실패(${name}): ${e.message} — 코드의 기본값으로 대체하지 않는다`, { cause: e });
  }
}


/**
 * 게이트 CLI 실행. 계약: stdout JSON 1줄 / exit 0=통과 1=실패 2=실행오류.
 *
 * @param {object} p
 * @param {string}   p.gate      게이트 이름 (에러 메시지 접두)
 * @param {Function} p.evaluate  (draftPath) => GateResult | Promise<GateResult>
 * @param {string}   [p.usage]   인자 없을 때 안내
 * @param {string[]} [p.argv]    테스트 주입용 (기본 process.argv)
 */
export async function runGateCli({ gate, evaluate, usage, argv = process.argv }) {
  const draftPath = argv[2];
  if (!draftPath) {
    process.stderr.write(`${usage || `Usage: check-${gate}.mjs <draft.md>`}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = await evaluate(draftPath);
  } catch (e) {
    // GateError 든 예상 못 한 예외든 실행오류로 통일한다. 판정을 못 냈다는 사실이
    // 중요하지, 왜 못 냈는지로 exit code 를 나눌 이유는 없다(계약이 3값이다).
    process.stderr.write(`check-${gate}: ${e.message}\n`);
    process.exit(2);
  }

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.pass ? 0 : 1);
}

/**
 * 파일 읽기 — 실패를 GateError 로 바꾼다.
 * 게이트마다 이 try/catch 가 복제돼 있었고 메시지 형식도 같았다.
 * (게이트 이름은 CLI 껍데기가 붙이므로 여기서는 받지 않는다.)
 */
export function readDraft(readFileSync, resolve, draftPath) {
  try {
    return readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
  }
}
