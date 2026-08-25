/**
 * cardnews-zip-route — ZIP 라우트를 **실제로 호출**해 인증·404·정상 zip 을 본다.
 * (문자열 검사가 아니라 핸들러 실행 — noopener 사건의 교훈)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth', () => ({ authOptions: {} }));
vi.mock('@/server/cardnews', () => ({ getAdminCardnews: vi.fn() }));

import { getServerSession } from 'next-auth';
import { getAdminCardnews } from '@/server/cardnews';
import { GET } from '@/app/api/admin/cardnews/zip/route';

const asAdmin = () =>
  (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: 'admin' } });
const rows = (v: unknown[]) =>
  (getAdminCardnews as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(v);
const req = (postId?: string) =>
  new NextRequest(`http://x/api/admin/cardnews/zip${postId ? `?post_id=${postId}` : ''}`);

const ROW = {
  post_id: 'cn-1',
  slide_urls: ['https://cdn/01.jpg', 'https://cdn/02.jpg'],
};

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode(`bytes-of-${String(url)}`).buffer,
  })) as unknown as typeof fetch;
});

describe('ZIP 라우트', () => {
  it('미인증이면 401 — 슬라이드 URL 조차 흘리지 않는다', async () => {
    (getServerSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect((await GET(req('cn-1'))).status).toBe(401);
    expect(getAdminCardnews).not.toHaveBeenCalled();
  });

  it('post_id 없으면 400', async () => {
    asAdmin();
    expect((await GET(req())).status).toBe(400);
  });

  it('없는 post_id 면 404', async () => {
    asAdmin();
    rows([]);
    expect((await GET(req('없는-id'))).status).toBe(404);
  });

  it('정상이면 zip 바이트 — PK 시그니처 + 순번 파일명 + 첨부 헤더', async () => {
    asAdmin();
    rows([ROW]);
    const res = await GET(req('cn-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain('cn-1.zip');

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.readUInt32LE(0)).toBe(0x04034b50);           // PK\x03\x04
    const i1 = body.indexOf('01.jpg', 0, 'ascii');
    const i2 = body.indexOf('02.jpg', 0, 'ascii');
    expect(i1).toBeGreaterThan(-1);
    expect(i2, '순번이 곧 카드 순서다').toBeGreaterThan(i1);
  });

  it('슬라이드 한 장이라도 실패하면 502 — 부분 zip 은 "빠진 카드"를 조용히 만든다', async () => {
    asAdmin();
    rows([ROW]);
    global.fetch = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('02') ? { ok: false, status: 500 } : {
        ok: true, arrayBuffer: async () => new ArrayBuffer(3),
      }) as unknown as typeof fetch;
    expect((await GET(req('cn-1'))).status).toBe(502);
  });
});
