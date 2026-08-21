/**
 * lib/main-module.mjs — "이 파일이 CLI 진입점으로 실행됐는가" 판정 (정본)
 *
 * 왜 정본이 필요한가: 이 저장소에는 같은 판정이 여러 관용구로 흩어져 있었고,
 * 그중 다수가 **파일명 접미사 문자열 매칭**이었다.
 *
 *     if (isMainModule(import.meta.url)) { ... }
 *
 * 이 형태는 두 가지로 조용히 틀린다.
 *   1) 파일을 리네임·이동하면 판정이 영원히 false 가 되어, 스크립트가 아무 일도
 *      하지 않고 exit 0 으로 끝난다. 예외도 로그도 없다.
 *   2) 같은 이름의 다른 파일이 진입점이면 **엉뚱한 모듈의 CLI 블록이 실행된다.**
 *      실제로 이 저장소에는 index.mjs 2개(notify/·shorts/tts/)와
 *      normalize.mjs 2개(reddit/·shorts/tts/)가 있다. 2026-08-21 기준 두 쌍 모두
 *      서로를 import 하지 않아 도달 불가였지만, 구조적으로 열려 있던 문이다.
 *
 * 판정은 경로 문자열이 아니라 **realpath 동일성**으로 한다. 심링크·상대경로·
 * `./` 접두 차이를 모두 흡수한다. realpath 가 실패하는 환경(삭제된 진입점 등)에서는
 * resolve 비교로 폴백한다.
 *
 * 사용:
 *   import { isMainModule } from '../lib/main-module.mjs';
 *   if (isMainModule(import.meta.url)) { main(); }
 */
import { realpathSync }  from 'node:fs';
import { resolve }       from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} metaUrl 호출한 모듈의 `import.meta.url`
 * @returns {boolean} 그 모듈이 곧 프로세스의 진입점이면 true
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(metaUrl) === resolve(process.argv[1]);
  }
}
