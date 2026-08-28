/**
 * home-isr-revalidation.test.ts — 홈이 그리는 것을 고치면 홈도 갱신돼야 한다.
 *
 * 🔴 홈(`/`)은 ISR(`revalidate = 300`)이다. 관리자가 저장해도 최대 5분간 옛 화면이 남는데,
 *    관리자는 저장 직후 홈을 확인하므로 그 사이가 **"반영이 안 된다"** 로 읽힌다.
 *    실제로 프로필을 고쳤는데 홈에 그대로였고(2026-08-28), DB 에는 정상 저장돼 있었다.
 *    공지 API 는 처음부터 `revalidatePath('/')` 를 부르고 있었고 나머지 셋만 빠져 있었다.
 *
 * ⚠ 에이전트 API 에는 "`/agents` 는 force-dynamic 이라 무효화 불필요"라는 주석까지 있었다.
 *    그 페이지에 대해서는 맞는 말이지만 **소비자가 둘**이고 다른 하나가 ISR 이었다.
 *    "이 페이지는 괜찮다"가 아니라 "이 데이터를 누가 그리는가"로 판단해야 한다.
 *
 * 검사 방식: 홈이 import 하는 서버 모듈을 읽어 **관리자가 고칠 수 있는** 소스를 찾고,
 * 그 소스를 쓰는 관리자 API 가 `revalidatePath('/')` 를 부르는지 본다. 소스 코드를 읽는
 * 방식이라 새 API 가 생겨도 자동으로 걸린다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');
const HOME = join(ROOT, 'app', '(site)', 'page.tsx');

/** 홈이 그리는 데이터 중 **관리자 화면에서 편집 가능한** 것 → 그 편집 API. */
const EDITABLE_SOURCES = [
  { what: '공개 프로필', api: 'profile' },
  { what: '프로젝트', api: 'projects' },
  { what: '에이전트', api: 'agents' },
  { what: '공지', api: 'notices' },
] as const;

const apiPath = (name: string) => join(ROOT, 'app', 'api', 'admin', name, 'route.ts');
const read = (p: string) => readFileSync(p, 'utf8');

describe('홈 ISR — 편집하면 홈도 갱신된다', () => {
  it('홈은 ISR 이다(이 테스트의 전제)', () => {
    // 전제가 사라지면(예: force-dynamic 전환) 아래 요구가 과잉이 된다. 전제부터 고정한다.
    expect(read(HOME)).toMatch(/export const revalidate\s*=\s*\d+/);
  });

  it.each(EDITABLE_SOURCES)('$what 을 홈이 실제로 그린다', ({ api }) => {
    const home = read(HOME);
    // 홈이 그리지 않는 데이터에까지 무효화를 요구하면 불필요한 캐시 폐기가 된다.
    const drawn = { profile: 'getProfile', projects: 'getProjects', agents: 'getActiveAgents', notices: 'getPinnedNotices' }[api];
    expect(home).toContain(drawn!);
  });

  it.each(EDITABLE_SOURCES)('$what 저장 API 가 홈 캐시를 버린다', ({ api }) => {
    const src = read(apiPath(api));
    expect(src).toContain("revalidatePath('/')");
  });

  /**
   * 쓰기 메서드마다 확인한다. POST 에만 걸고 DELETE 를 빠뜨리면 "지웠는데 홈에 남아 있다"가
   * 되는데, 이건 추가보다 더 이상해 보인다.
   */
  it.each(EDITABLE_SOURCES)('$what — 쓰기 메서드 수만큼 무효화가 있다', ({ api }) => {
    const files = [apiPath(api), join(ROOT, 'app', 'api', 'admin', api, '[id]', 'route.ts')].filter(existsSync);
    const src = files.map(read).join('\n');
    const writes = (src.match(/export async function (POST|PUT|PATCH|DELETE)/g) ?? []).length;
    const revalidates = (src.match(/revalidatePath\('\/'\)/g) ?? []).length;
    expect(revalidates).toBeGreaterThanOrEqual(writes);
  });
});
