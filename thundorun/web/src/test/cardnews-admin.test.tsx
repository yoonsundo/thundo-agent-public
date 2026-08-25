/**
 * cardnews-admin — 반자동 발행 화면을 **실제로 렌더해서** 누른다.
 *
 * 왜 소스 문자열 검사로는 부족했나: 이전 판은 `expect(src).toMatch(/팝업이 차단/)` 로
 * "차단을 감지해 알린다"를 통과시켰다. 그런데 그 감지는 **항상 거짓 경보**를 냈다 —
 * `window.open(url, '_blank', 'noopener')` 는 창이 정상적으로 열려도 null 을 돌려주기 때문이다
 * (HTML 표준. 실 Chromium 확인: features 없음→Window, 'noopener'→null).
 * 문자열은 코드가 무엇을 의도했는지만 증명하고 무엇을 하는지는 증명하지 못한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CardnewsAdmin from '@/components/CardnewsAdmin';

const READY = {
  post_id: 'cn-2026-08-21-abc',
  subject: '남으려면 나를 버려야 할 때',
  problem: '관계에서 나를 지우게 될 때',
  book: 'Jane Eyre',
  author: 'Charlotte Brontë',
  cover_url: 'https://cdn.example/cover.jpg',
  slide_urls: ['https://cdn.example/01.jpg', 'https://cdn.example/02.jpg'],
  caption: '남으려고 애쓸수록…',
  bgm_suggestions: [
    { title: 'River Flows in You', artist: 'Yiruma', mood: '잔잔한 피아노' },
    { title: 'Gymnopédie No.1', artist: 'Erik Satie', mood: '고요' },
    { title: 'Clair de Lune', artist: 'Debussy', mood: '' },
  ],
  permalink: null,
  published_at: null,
  active: true,
  status: 'ready' as const,
};

/** 클릭 순서를 기록해 "창 열기가 await 보다 먼저"를 실제 호출로 확인한다. */
let calls: string[] = [];

function stubFetch(rows: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/admin/cardnews')) {
      calls.push(init?.method === 'POST' ? `post:${String(init.body)}` : 'list');
      return { ok: true, json: async () => (init?.method === 'POST' ? { ok: true } : rows) };
    }
    calls.push(`slide:${url}`);
    return { ok: true, blob: async () => new Blob(['x']) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  global.fetch = stubFetch([READY]);
  // jsdom 에는 없다 — 슬라이드 다운로드가 이걸 쓴다.
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

/** 카드를 펼친다 — 동선 버튼은 검수 패널 안에 있다. */
async function openCard() {
  const user = userEvent.setup();
  // ⚠ userEvent.setup() 이 navigator.clipboard 를 자기 스텁으로 갈아 끼운다 → 그 뒤에 덮어야 한다.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => { calls.push('clipboard'); }) },
  });
  render(<CardnewsAdmin />);
  await user.click(await screen.findByRole('button', { name: '검수' }));
  return user;
}

describe('카드뉴스 관리자 화면', () => {
  it('발행대기 카드를 배지와 함께 보여 준다', async () => {
    render(<CardnewsAdmin />);
    expect(await screen.findByText('발행 대기')).toBeInTheDocument();
    expect(screen.getByText(READY.subject)).toBeInTheDocument();
  });

  it('슬라이드 썸네일이 원본으로 열린다 — 96px 축소본으로는 글자를 읽을 수 없다', async () => {
    await openCard();
    for (const [i, url] of READY.slide_urls.entries()) {
      const img = screen.getByAltText(`슬라이드 ${i + 1}`);
      const link = img.closest('a');
      expect(link, '썸네일이 링크로 감싸져 있어야 한다').not.toBeNull();
      expect(link).toHaveAttribute('href', url);
      expect(link).toHaveAttribute('target', '_blank');
    }
  });

  it('창이 열리면 "열었다"고 말한다 — 거짓 경보를 내지 않는다', async () => {
    const fakeWin = { opener: {}, closed: false } as unknown as Window;
    // 🔴 브라우저 규칙을 목에 심는다: features 에 noopener 가 있으면 **열려도 null** 이다.
    //    이게 없으면 'noopener' 를 되돌려도 이 테스트가 초록으로 남아 회귀를 놓친다.
    const open = vi.spyOn(window, 'open').mockImplementation((_u, _t, features) =>
      String(features ?? '').includes('noopener') ? null : fakeWin);
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /인스타 열고 준비/ }));

    await waitFor(() => expect(screen.getByText(/인스타를 열었습니다/)).toBeInTheDocument());
    expect(screen.queryByText(/팝업이 차단/)).toBeNull();
    // 🔴 features 에 noopener 를 넘기면 열려도 null 이 온다 → 감지가 매번 뒤집힌다.
    expect(String(open.mock.calls[0][2] ?? '')).not.toContain('noopener');
    expect(fakeWin.opener, 'opener 는 코드가 끊는다').toBeNull();
  });

  it('인스타는 홈으로 연다 — /create/select/ 딥링크는 @create 라는 남의 프로필로 해석된다', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /인스타 열고 준비/ }));

    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][0]).toBe('https://www.instagram.com/');
  });

  it('진짜로 차단되면(null) 그때만 차단이라고 말한다', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /인스타 열고 준비/ }));

    await waitFor(() => expect(screen.getByText(/팝업이 차단/)).toBeInTheDocument());
  });

  it('즉시 닫히는 창을 주는 차단기(확장형)도 차단으로 본다', async () => {
    vi.spyOn(window, 'open').mockReturnValue({ opener: {}, closed: true } as unknown as Window);
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /인스타 열고 준비/ }));

    await waitFor(() => expect(screen.getByText(/팝업이 차단/)).toBeInTheDocument());
  });

  it('창 열기 → ZIP 다운로드 → 클립보드 순서다 — 앞 둘은 제스처 안(동기)이어야 한다', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => { calls.push('open'); return null; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      if (this.href) calls.push(`zip:${this.getAttribute('href')}`);
    });
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /인스타 열고 준비/ }));

    await waitFor(() => expect(calls).toContain('clipboard'));
    const zipIdx = calls.findIndex((c) => c.startsWith('zip:'));
    expect(calls.indexOf('open')).toBeLessThan(zipIdx);
    expect(zipIdx, 'zip 은 await(클립보드) 앞 — 제스처가 소멸하면 다운로드가 조용히 막힌다')
      .toBeLessThan(calls.indexOf('clipboard'));
  });

  it('ZIP 은 same-origin 라우트를 가리킨다 — blob 7연속 다운로드는 실사용 0건이 났다', async () => {
    const hrefs: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute('href') ?? '');
    });
    const user = await openCard();

    await user.click(screen.getByRole('button', { name: /슬라이드 ZIP 받기/ }));

    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toBe(`/api/admin/cardnews/zip?post_id=${encodeURIComponent(READY.post_id)}`);
  });

  it('BGM 추천 3곡이 표시되고 복사 버튼이 "곡명 아티스트" 를 복사한다', async () => {
    const user = await openCard();

    // 3곡 전부 곡명·아티스트가 보인다
    for (const b of READY.bgm_suggestions) {
      expect(screen.getByText(b.title)).toBeInTheDocument();
    }
    expect(screen.getByText(/잔잔한 피아노/)).toBeInTheDocument();

    // 복사 버튼 → 인스타 음악 검색창에 그대로 칠 텍스트
    const copies = screen.getAllByRole('button', { name: /^복사$/ });
    expect(copies).toHaveLength(3);
    await user.click(copies[0]);
    await waitFor(() => expect(calls).toContain('clipboard'));
  });

  it('BGM 추천이 없으면 추천 영역이 렌더되지 않는다 — 빈 문구도 없다', async () => {
    global.fetch = stubFetch([{ ...READY, bgm_suggestions: [] }]);
    await openCard();
    expect(screen.queryByText(/추천 음악/)).toBeNull();
  });

  it('클립보드가 막혀도 캡션을 손으로 복사할 수 있다', async () => {
    await openCard();
    const box = screen.getByLabelText(/캡션/) as HTMLTextAreaElement;
    expect(box).toHaveValue(READY.caption);
    expect(box.readOnly, '원문이 바뀌면 안 된다').toBe(true);
    expect(screen.getByRole('button', { name: /캡션만 복사/ })).toBeInTheDocument();
  });

  it('퍼머링크가 형식에 안 맞으면 서버를 부르지 않는다', async () => {
    const user = await openCard();
    await user.type(screen.getByRole('textbox', { name: /게시물 링크/ }), 'https://example.com/x');
    await user.click(screen.getByRole('button', { name: /발행 완료/ }));

    await waitFor(() => expect(screen.getByText(/인스타 게시물 링크를 붙여넣으세요/)).toBeInTheDocument());
    expect(calls.filter((c) => c.startsWith('post:'))).toHaveLength(0);
  });

  it('올바른 링크면 발행을 요청하고 공개됐다고 알린다', async () => {
    const user = await openCard();
    await user.type(
      screen.getByRole('textbox', { name: /게시물 링크/ }),
      'https://www.instagram.com/p/CxyzAbc123/',
    );
    await user.click(screen.getByRole('button', { name: /발행 완료/ }));

    await waitFor(() => expect(screen.getByText(/이제 일반 사용자에게 공개됩니다/)).toBeInTheDocument());
    const post = calls.find((c) => c.startsWith('post:'));
    expect(post).toContain('"action":"publish"');
    expect(post).toContain(READY.post_id);
  });
});
