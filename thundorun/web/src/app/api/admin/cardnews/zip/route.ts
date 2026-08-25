/**
 * /api/admin/cardnews/zip?post_id= — 슬라이드 전량을 ZIP 하나로 (관리자 전용)
 *
 * 왜 서버에서 묶나: 브라우저 blob 7연속 다운로드는 `await` 뒤 사용자 제스처 소멸 +
 * "여러 파일 다운로드 허용?" 프롬프트가 겹쳐 실사용에서 0건이 났다(2026-08-24 실측).
 * same-origin GET 하나면 앵커 클릭 즉시 내려가고 차단 요소가 없다.
 *
 * zip 안 파일명은 01.jpg~0N.jpg — 인스타 업로드 화면의 파일 선택이 이름순이라
 * 순번이 곧 카드 순서가 된다.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession }          from 'next-auth';
import { authOptions }               from '@/lib/auth';
import { getAdminCardnews }          from '@/server/cardnews';
import { makeZip, ZipEntry }         from '@/server/zip';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return Boolean(session && session.user?.role === 'admin');
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: '인증 필요' }, { status: 401 });

  const postId = String(req.nextUrl.searchParams.get('post_id') ?? '').trim();
  if (!postId) return NextResponse.json({ error: 'post_id 가 필요하다' }, { status: 400 });

  const row = (await getAdminCardnews()).find((r) => r.post_id === postId);
  if (!row) return NextResponse.json({ error: '해당 카드뉴스를 찾지 못했다' }, { status: 404 });
  if (!row.slide_urls.length) return NextResponse.json({ error: '슬라이드가 없다' }, { status: 404 });

  // 슬라이드는 공개 버킷이라 서버 fetch 에 인증이 필요 없다. 한 장이라도 실패하면
  // 전체를 실패로 처리한다 — 부분 zip 은 "빠진 카드"를 조용히 만들고, 인스타에는
  // 삭제 API 가 없어 올라간 뒤에는 되돌릴 수 없기 때문이다.
  const entries: ZipEntry[] = [];
  for (const [i, url] of row.slide_urls.entries()) {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json(
        { error: `슬라이드 ${i + 1} 다운로드 실패 (HTTP ${res.status})` }, { status: 502 },
      );
    }
    entries.push({
      name: `${String(i + 1).padStart(2, '0')}.jpg`,
      data: new Uint8Array(await res.arrayBuffer()),
    });
  }

  const zip = makeZip(entries);
  // 파일명은 헤더에 박히므로 안전 문자만 남긴다 — post_id 는 우리 생성값이지만 쿼리로도 들어온다.
  const safeName = postId.replace(/[^A-Za-z0-9._-]/g, '_');
  return new NextResponse(Buffer.from(zip), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeName}.zip"`,
      'Content-Length': String(zip.length),
      'Cache-Control': 'no-store',
    },
  });
}
