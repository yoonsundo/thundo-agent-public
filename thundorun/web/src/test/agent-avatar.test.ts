/**
 * agent-avatar — 에이전트 아바타 계약 테스트
 *
 * 왜 필요한가: 이 화면의 아바타는 `name.slice(0, 1)` 이라 **6개 군 13명이 충돌**했다
 * (라=라이언·라이노·라쿤, 비=비버·비, 스=스완·스파이더, 배=배저·배포담당,
 *  디=디자이너·디어, 헤=헤론·헤지호그). 고쳐도 에이전트가 추가되면 조용히 재발한다.
 * 그래서 "문서에만 있는 규칙은 반드시 썩는다"는 이 저장소 원칙대로 테스트로 고정한다.
 *
 * ⚠ 이 화면은 **가드 사각지대**다 — `/agents` 가 로그인 게이트 뒤라(middleware.ts)
 *   e2e 이모지 검사(kit.spec.ts GATED_ROUTES)가 DOM 을 한 번도 보지 못하고,
 *   design-guard 소스 스캔은 `agent.emoji` 를 변수로 보아 통과한다.
 *   즉 규칙 8 위반이 초록 테스트를 통과할 수 있다. 이 파일이 그 구멍을 일부 메운다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MONOGRAMS } from '@/components/ui/AgentAvatar';
import { AGENT_PORTRAITS } from '@/components/ui/agent-portraits';

const ROOT = process.cwd();

/** agents.sql 시드에서 (id, name) 을 뽑는다 — 화면에 실제로 뜨는 명단이다. */
function seedAgents(): { id: string; name: string }[] {
  const sql = readFileSync(join(ROOT, 'supabase/agents.sql'), 'utf8');
  const re = /\(\s*'([a-z0-9-]+)'\s*,\s*'([^']+)'\s*,/g;
  const out: { id: string; name: string }[] = [];
  for (const m of sql.matchAll(re)) out.push({ id: m[1], name: m[2] });
  return out;
}

describe('에이전트 아바타', () => {
  const agents = seedAgents();

  it('시드에서 에이전트를 읽어온다(파싱이 깨지면 아래 검사가 무의미해진다)', () => {
    expect(agents.length).toBeGreaterThan(30);
  });

  it('모든 에이전트가 아바타를 갖는다 — 초상·역할아이콘·모노그램 중 하나', () => {
    const DEV = agents.filter((a) => a.id.startsWith('dev-')).map((a) => a.id);
    const missing = agents.filter(
      (a) => !AGENT_PORTRAITS.has(a.id) && !DEV.includes(a.id) && !AGENT_MONOGRAMS[a.id],
    );
    expect(missing.map((a) => a.id), '아바타 없는 에이전트').toEqual([]);
  });

  it('모노그램이 서로 충돌하지 않는다 — 이 테스트가 없으면 "라/라/라" 가 재발한다', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [id, mono] of Object.entries(AGENT_MONOGRAMS)) {
      const prev = seen.get(mono);
      if (prev) dup.push(`${mono}: ${prev} ↔ ${id}`);
      else seen.set(mono, id);
    }
    expect(dup, '모노그램 충돌').toEqual([]);
  });

  it('모노그램은 시드에 있는 id 만 담는다(오타·유령 항목 차단)', () => {
    const ids = new Set(agents.map((a) => a.id));
    const ghost = Object.keys(AGENT_MONOGRAMS).filter((id) => !ids.has(id));
    expect(ghost, '시드에 없는 id').toEqual([]);
  });

  it('초상 목록과 실제 파일이 일치한다 — 한쪽만 고치면 빈 원이 뜬다', () => {
    const dir = join(ROOT, 'public/agent-portraits');
    const files = new Set(
      readdirSync(dir).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4)),
    );
    const listedButMissing = [...AGENT_PORTRAITS].filter((id) => !files.has(id));
    const fileButUnlisted = [...files].filter((id) => !AGENT_PORTRAITS.has(id));
    expect(listedButMissing, '목록에 있는데 파일 없음').toEqual([]);
    expect(fileButUnlisted, '파일은 있는데 목록에 없음(렌더 안 됨)').toEqual([]);
  });

  it('시드가 모든 에이전트에 image_url 을 채운다 — DB 가 아바타의 단일 출처다', () => {
    const sql = readFileSync(join(ROOT, 'supabase/agents.sql'), 'utf8');
    const block = sql.match(/set image_url = '\/agent-portraits\/'[\s\S]*?and id in \(([\s\S]*?)\);/);
    expect(block, 'image_url 배선 update 문을 찾지 못함').toBeTruthy();
    const wired = new Set([...block![1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
    const notWired = agents.filter((a) => !wired.has(a.id)).map((a) => a.id);
    expect(notWired, '시드에 있는데 image_url 이 안 채워지는 에이전트').toEqual([]);
    const noFile = [...wired].filter((id) => !AGENT_PORTRAITS.has(id));
    expect(noFile, 'image_url 은 채우는데 초상 파일이 없음 → 깨진 이미지').toEqual([]);
  });

  it('에이전트를 보여주는 화면은 모두 공용 아바타를 쓴다 — 한 곳만 빠지면 얼굴이 갈린다', () => {
    // 실제로 겪었다: 소개 카드만 고쳤더니 홈의 "에이전트 팀"·흐름도·관리자·대화가
    // 각자 첫 글자/이니셜을 쓰고 있어 같은 에이전트가 화면마다 다르게 보였다.
    const sites = [
      'src/app/(site)/agents/page.tsx',
      'src/app/(site)/agents/PipelineTree.tsx',
      'src/components/ProjectsDashboard.tsx',
      'src/components/AgentsAdmin.tsx',
      'src/components/AgentChat.tsx',
    ];
    const bad: string[] = [];
    for (const f of sites) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      if (!src.includes('AgentAvatar')) bad.push(`${f}: 공용 아바타 미사용`);
      // 에이전트 이름/ID 첫 글자를 직접 찍는 패턴이 남아 있으면 갈라진 것이다.
      if (/\{\s*a\.name\.slice\(0, 1\)|\{\s*agent\.name\.slice\(0, 1\)|\{initials\(a\.id\)\}/.test(src)) {
        bad.push(`${f}: 첫 글자 아바타 잔존`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('초상은 시드에 있는 id 만 쓴다', () => {
    const ids = new Set(agents.map((a) => a.id));
    expect([...AGENT_PORTRAITS].filter((id) => !ids.has(id)), '시드에 없는 초상').toEqual([]);
  });

  it('개발팀 9인도 초상을 갖는다 — lucide 아이콘은 "비어 보인다"는 사용자 지적으로 교체됐다', () => {
    const dev = agents.filter((a) => a.id.startsWith('dev-'));
    expect(dev.length, '개발팀 인원').toBeGreaterThan(0);
    const noPortrait = dev.filter((a) => !AGENT_PORTRAITS.has(a.id)).map((a) => a.id);
    expect(noPortrait, '초상 없는 개발팀').toEqual([]);
  });

  it('아바타 컴포넌트는 이모지를 렌더하지 않는다 (규칙 8 — 이 화면은 e2e 사각지대다)', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const f of ['AgentAvatar.tsx', 'agent-portraits.ts']) {
      const src = readFileSync(join(ROOT, 'src/components/ui', f), 'utf8');
      // 주석에 든 설명용 이모지는 제외하고 **코드 줄**만 본다.
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      expect(EMOJI.test(code), `${f} 코드에 이모지`).toBe(false);
    }
  });

  it('초상 경로가 로그인 게이트에 잡히지 않는다 — 잡히면 이미지가 307 로 튕긴다', () => {
    // 실제로 겪었다: public/agents/ 에 뒀더니 middleware 가 `/agents/*` 를 requireLogin 으로
    // 보내 /agents/lion.jpg 가 배포 후 307 이었다. 게이트를 느슨하게 푸는 대신 경로를 옮겼다.
    const mw = readFileSync(join(ROOT, 'src/middleware.ts'), 'utf8');
    const gated = [...mw.matchAll(/pathname\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
    const avatar = readFileSync(join(ROOT, 'src/components/ui/AgentAvatar.tsx'), 'utf8');
    const srcPath = avatar.match(/src=\{`(\/[a-z-]+)\//)?.[1];
    expect(srcPath, '초상 src 경로를 찾지 못함').toBeTruthy();
    const clash = gated.filter((g) => `${srcPath}/`.startsWith(g));
    expect(clash, `초상 경로 ${srcPath} 가 게이트된 경로와 겹친다`).toEqual([]);
  });

  it('아바타는 모든 분기에서 avatar-neutral 을 붙인다 — 빠지면 빨간 원이 뜬다', () => {
    const src = readFileSync(join(ROOT, 'src/components/ui/AgentAvatar.tsx'), 'utf8');
    // 컨테이너 클래스는 한 곳에서만 만든다(분기마다 손으로 쓰면 또 빠뜨린다).
    expect(src).toMatch(/const cls = \['avatar', sizeClass, 'avatar-neutral'\]/);
    const handRolled = src.match(/className="avatar(?! \$)/g) ?? [];
    expect(handRolled, 'cls 를 안 쓰고 직접 쓴 avatar 클래스').toEqual([]);
  });
});
