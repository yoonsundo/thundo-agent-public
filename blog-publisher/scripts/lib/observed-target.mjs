/**
 * observed-target.mjs — 관찰 대상(호스트·경로) 조회.
 *
 * Parrot·Woodpecker 가 들여다보는 서버와 경로는 **우리 자산이 아니라 거래처 자산**이다.
 * 저장소에 상수로 박아 두면 저장소를 공개하는 순간 남의 인프라 목록을 공개하는 셈이라,
 * 값은 `config/observed-targets.json`(git 제외)에만 두고 코드는 키로만 참조한다.
 * 형식은 `config/observed-targets.example.json` 참고.
 *
 * 라이브러리: `import { observedTarget } from '../lib/observed-target.mjs'`
 * 셸 게이트웨이: `node scripts/lib/observed-target.mjs parrot host` → 값만 stdout,
 *   미설정이면 exit 3. 게이트웨이가 빈 호스트로 ssh 를 붙는 사고를 막으려고 조용히
 *   빈 문자열을 주지 않는다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const CONFIG_PATH = process.env.OBSERVED_TARGETS_FILE
  || resolve(dirname(SELF), '../../config/observed-targets.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cache = {};   // 미설정도 정상 상태 — 호출자가 판단한다
  }
  return cache;
}

/**
 * @param {string} agent 관찰 주체 (`parrot` | `woodpecker` …)
 * @param {string} key   `host` | `base` | `name` …
 * @returns {string|null} 값이 없으면 null — 호출자가 명시적으로 실패시켜야 한다.
 */
export function observedTarget(agent, key) {
  const v = load()?.[agent]?.[key];
  return typeof v === 'string' && v ? v : null;
}

// CLI 모드 — 셸 게이트웨이가 값을 읽는 통로.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) {
  const [agent, key] = process.argv.slice(2);
  const value = observedTarget(agent, key);
  if (!value) {
    console.error(
      `[observed-target] 미설정: ${agent}.${key}\n`
      + `  ${CONFIG_PATH} 를 확인하라 (형식: config/observed-targets.example.json).`,
    );
    process.exit(3);
  }
  process.stdout.write(value);
}
