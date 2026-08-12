import crypto from 'node:crypto';

/**
 * 로컬 E2E 전용 NEXTAUTH_SECRET.
 *
 * 왜 이 파일이 있나
 * - `playwright.config.ts`(서버 기동)와 세션 쿠키를 직접 서명하는 스펙이 **같은 값**을 써야 한다.
 *   값을 양쪽에 하드코딩하면 (a) 커밋물에 시크릿 형태 문자열이 남아 `scan:secrets` 에 걸리고,
 *   (b) 누군가 그걸 실제 설정으로 복사해 쓸 위험이 생기고, (c) 한쪽만 바꾸면 조용히 깨진다.
 * - 그래서 **리터럴을 두지 않고 고정 입력에서 파생**한다. 프로세스마다 계산해도 같은 값이 나오므로
 *   config 와 워커가 값을 주고받을 필요가 없다.
 *
 * 보안상 의미
 * - 이 값은 `127.0.0.1` 로컬 E2E 서버에서만 쓰이고 배포 경로에 들어가지 않는다.
 * - 실제 값이 환경에 있으면 그것을 우선한다(CI 에서 주입하는 경우).
 */
export const E2E_NEXTAUTH_SECRET =
  process.env.NEXTAUTH_SECRET ??
  crypto.createHash('sha256').update('thundorun-local-e2e-only').digest('base64');
