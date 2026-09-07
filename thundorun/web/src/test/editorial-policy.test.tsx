/**
 * editorial-policy — 편집 정책 페이지가 실제로 존재하고, 닿을 수 있고, 사실만 적는지.
 *
 * 왜 필요한가(2026-09-07): 구글은 AI 생성 자체를 금지하지 않는다. 금지하는 것은 "의미 있는
 * 사람 검토와 부가가치가 없는" 대량 생성이다. 이 사이트는 이미 "에이전트가 운영한다"를
 * 공개 브랜드로 쓰므로 숨길 이유가 없다 — 무엇을 기계가 하고 어디서 사람이 막는지를 밝힌다.
 *
 * ⚠ 이 테스트는 문구를 검사하지 않는다(문구는 바뀐다). 검사하는 것은 셋이다:
 *    ① 세 주제(검수 주체 · AI 사용 고지 · 정정 절차)가 모두 있는가
 *    ② 홈과 글 하단 양쪽에서 닿는가
 *    ③ 정정 창구가 **실제 링크**인가 — "문의 바랍니다"만 적힌 정책은 창구가 없는 것이다
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/supabase', () => ({ getSupabase: vi.fn() }));

import { getSupabase } from '@/lib/supabase';

beforeEach(() => {
  vi.clearAllMocks();
  // DB 미연결 → siteProfile 의 하드코딩 폴백을 쓴다. 정정 창구가 폴백에서도 살아 있어야 한다.
  (getSupabase as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
});

async function renderPolicy() {
  const Page = (await import('@/app/(site)/editorial-policy/page')).default;
  return render(await Page());
}

describe('편집 정책 페이지', () => {
  it('세 주제를 모두 다룬다 — 검수 주체 · AI 사용 고지 · 정정 절차', async () => {
    await renderPolicy();
    expect(screen.getByRole('heading', { level: 1, name: /편집 정책/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /누가 무엇을 검수/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /AI 사용 고지/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /정정 절차/ })).toBeInTheDocument();
  });

  it('정정 창구가 눌러지는 링크다', async () => {
    const { container } = await renderPolicy();
    // 주소 자체는 프로필에서 오므로 값이 아니라 **경로가 살아 있는지**를 본다.
    expect(container.querySelector('a[href^="mailto:"]')).not.toBeNull();
  });

  it('관문 이전 글에 검수자가 없다는 사실을 숨기지 않는다', async () => {
    await renderPolicy();
    // 🔴 없는 사실을 지어내지 않는 대신, 왜 비어 있는지는 반드시 설명해야 한다.
    //    설명 없이 비워 두면 "어떤 글은 검수하고 어떤 글은 안 하나"로 읽힌다.
    expect(screen.getByText(/이전에 발행된 글에는 검수자 표시가 없습니다/)).toBeInTheDocument();
  });

  it('지키지 못할 약속을 적지 않는다 — 숫자는 실제 파이프라인 값이다', async () => {
    await renderPolicy();
    expect(screen.getByText(/자동 검사 17종/)).toBeInTheDocument();   // scripts/gates 실측(배포 점검 2종 제외)
    expect(screen.getByText(/검증 에이전트 4명/)).toBeInTheDocument(); // config/pipeline.json validators
    expect(screen.getByText(/주 3편\(월·수·금\)/)).toBeInTheDocument();
  });
});

describe('닿을 수 있는가', () => {
  it('푸터에 링크가 있다 — 홈을 포함한 모든 공개 화면에서 닿는다', async () => {
    const SiteFooter = (await import('@/components/SiteFooter')).default;
    const { container } = render(<SiteFooter />);
    expect(container.querySelector('a[href="/editorial-policy"]')).not.toBeNull();
  });

  it('글 하단에도 링크가 있다', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/(site)/blog/[slug]/page.tsx'), 'utf8');
    expect(src).toContain('href="/editorial-policy"');
  });

  it('sitemap 에 실린다 — 검색엔진이 편집 감독을 확인하러 오는 문이다', async () => {
    const sitemap = (await import('@/app/sitemap')).default;
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain('https://www.thundo.kr/editorial-policy');
  });

  it('llms.txt 에도 실린다 — AI 크롤러가 읽는 카탈로그', async () => {
    const { GET } = await import('@/app/llms.txt/route');
    expect(await (await GET()).text()).toContain('/editorial-policy');
  });
});
