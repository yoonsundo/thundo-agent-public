'use client';

/**
 * CardnewsAdmin — 인스타 카드뉴스 반자동 발행 화면 (관리자 전용)
 *
 * 왜 반자동인가: 인스타 캐러셀에 **음악을 넣을 수 없어** 완전 자동 발행을 포기했다
 * (2026-08-21 사용자 결정). 파이프라인은 제작·호스팅까지만 하고 여기서 사람이 마무리한다.
 *
 * 관리자 동선 — 위에서 아래로 한 줄이다.
 *   ① 발행대기 카드를 열어 슬라이드 7장과 캡션을 눈으로 검수한다
 *   ② [인스타 열고 준비] — 캡션을 클립보드에 담고 슬라이드를 순번대로 내려받은 뒤 인스타를 연다
 *   ③ 인스타에서 올린다(사람이 하는 유일한 부분)
 *   ④ 퍼머링크를 붙여넣고 [발행 완료] — **이때 비로소 일반 사용자에게 공개된다**
 *
 * ⚠ 브라우저가 팝업을 막을 수 있어 인스타 창은 **사용자 클릭 핸들러 안에서 즉시** 연다.
 *   await 뒤에 window.open 을 두면 "사용자 제스처"가 끊겨 차단된다.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, ExternalLink, Music, Undo2, X } from 'lucide-react';

interface Row {
  post_id: string;
  subject: string;
  problem: string;
  book: string;
  author: string;
  cover_url: string | null;
  slide_urls: string[];
  caption: string | null;
  bgm_suggestions: { title: string; artist: string; mood: string }[];
  permalink: string | null;
  published_at: string | null;
  active: boolean;
  status: 'ready' | 'published';
}

/**
 * 인스타 홈. ⚠ 새 게시물 화면(`/create/select/`)으로 딥링크하면 안 된다 — 그 경로는 앱 내부
 * 라우트라, 직접 열면 인스타가 **`@create` 라는 남의 프로필**로 해석한다(2026-08-24 실측,
 * 관리자가 "이상한 사람 인스타가 열린다"로 발견). 홈에서 [+ 만들기] 한 번이 정답이다.
 */
const INSTAGRAM_NEW_POST = 'https://www.instagram.com/';

/** 인스타 게시물 링크만 받는다 — 서버도 같은 검사를 한다(클라이언트만 믿지 않는다). */
function isPermalink(v: string): boolean {
  return /^https:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]{5,}\/?(\?.*)?$/.test(v.trim());
}

/**
 * 슬라이드 전량을 ZIP 하나로 내려받는다 — 서버(/api/admin/cardnews/zip)가 01.jpg~0N.jpg
 * 순번으로 묶는다. ⚠ 예전의 blob 7연속 다운로드는 실사용에서 0건이 났다: `await fetch` 뒤라
 * 사용자 제스처가 소멸해 브라우저가 조용히 막고, "여러 파일 다운로드 허용?" 프롬프트까지
 * 겹쳤다. same-origin 앵커 클릭은 동기라 제스처가 살아 있고 파일도 하나다.
 */
function downloadZip(row: Row): void {
  const a = document.createElement('a');
  a.href = `/api/admin/cardnews/zip?post_id=${encodeURIComponent(row.post_id)}`;
  a.download = `${row.post_id}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function CardnewsAdmin() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/cardnews');
      setRows(res.ok ? await res.json() : []);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** ② 인스타를 열고 캡션·이미지를 손에 쥐여 준다. 창 열기가 먼저다(팝업 차단 회피). */
  const prepare = useCallback(async (row: Row) => {
    // ⚠ 세 번째 인자에 'noopener' 를 넣으면 **창이 정상적으로 열려도 null 이 돌아온다**
    //   (HTML 표준. 실 Chromium 으로 확인: features 없음→Window, 'noopener'→null).
    //   그대로 두면 차단 감지가 매번 거짓 경보를 냈다 → features 를 비우고 opener 는 여기서 끊는다.
    const win = window.open(INSTAGRAM_NEW_POST, '_blank');
    if (win) win.opener = null;
    // 내장 차단기는 null 을 주지만, 확장 기반 차단기는 **즉시 닫히는 Window** 를 준다.
    // 진짜로 열린 탭은 closed === false 이므로 둘을 함께 보면 오탐이 없다.
    const blocked = !win || win.closed;
    let note = blocked ? '팝업이 차단돼 인스타를 열지 못했습니다 — 직접 여세요.' : '인스타를 열었습니다.';

    // zip 다운로드도 클릭 제스처 안에서(동기) — await 뒤로 밀면 조용히 차단될 수 있다.
    downloadZip(row);
    note += ` 슬라이드 ${row.slide_urls.length}장 ZIP 다운로드를 시작했습니다.`;

    if (row.caption) {
      try {
        await navigator.clipboard.writeText(row.caption);
        note += ' 캡션을 복사했습니다.';
      } catch {
        // https 가 아니거나 권한이 없으면 실패한다 — 아래 캡션 상자에서 직접 복사하면 된다.
        note += ' 캡션 복사는 실패했습니다 — 아래 캡션 상자에서 직접 복사하세요.';
      }
    }
    setMsg({ id: row.post_id, text: note, bad: blocked });
  }, []);

  /** ④ 여기서 공개로 바뀐다. */
  const publish = useCallback(async (row: Row) => {
    const link = (links[row.post_id] ?? '').trim();
    if (!isPermalink(link)) {
      setMsg({ id: row.post_id, text: '인스타 게시물 링크를 붙여넣으세요 (예: https://www.instagram.com/p/XXXXXXXXXXX/)', bad: true });
      return;
    }
    setBusy(row.post_id);
    try {
      const res = await fetch('/api/admin/cardnews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: row.post_id, action: 'publish', permalink: link }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { setMsg({ id: row.post_id, text: '발행 완료 — 이제 일반 사용자에게 공개됩니다.' }); await load(); }
      else setMsg({ id: row.post_id, text: body.error ?? '발행 처리에 실패했습니다.', bad: true });
    } finally {
      setBusy(null);
    }
  }, [links, load]);

  const unpublish = useCallback(async (row: Row) => {
    setBusy(row.post_id);
    try {
      const res = await fetch('/api/admin/cardnews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: row.post_id, action: 'unpublish' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { setMsg({ id: row.post_id, text: '발행을 취소했습니다 — 사이트에서 다시 감췄습니다.' }); await load(); }
      else setMsg({ id: row.post_id, text: body.error ?? '취소에 실패했습니다.', bad: true });
    } finally {
      setBusy(null);
    }
  }, [load]);

  const ready = rows.filter((r) => r.status === 'ready');
  const published = rows.filter((r) => r.status === 'published');

  if (loading) return <p className="card-body">불러오는 중…</p>;

  const card = (row: Row) => {
    const open = openId === row.post_id;
    const note = msg?.id === row.post_id ? msg : null;
    return (
      <div className="card" key={row.post_id}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-3)' }}>
          {row.cover_url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={row.cover_url} alt="" width={72} height={90}
              style={{ width: 72, height: 90, objectFit: 'cover', borderRadius: 'var(--radius-2)', flex: 'none' }} />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <span className={row.status === 'published' ? 'tag tag-success' : 'tag tag-accent'}>
              {row.status === 'published' ? (row.active ? '발행됨 · 공개' : '발행됨 · 숨김') : '발행 대기'}
            </span>
            <p className="card-title" style={{ marginTop: 'var(--space-2)' }}>{row.subject}</p>
            <p className="card-meta">
              {row.book}{row.author ? ` · ${row.author}` : ''} · 슬라이드 {row.slide_urls.length}장
            </p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => setOpenId(open ? null : row.post_id)}>
            {open ? '접기' : '검수'}
          </button>
        </div>

        {open && (
          <div className="stack" style={{ marginTop: 'var(--space-3)' }}>
            <p className="card-meta">{row.problem}</p>

            {/* 썸네일은 눌러서 원본(1080×1350)을 연다 — 카드에 문장과 인용 구절이 들어가서
                축소본으로는 글자를 읽을 수 없다. 검수가 이 화면의 존재 이유다. */}
            <div className="row" style={{ gap: 'var(--space-2)', overflowX: 'auto', paddingBottom: 4 }}>
              {row.slide_urls.map((u, i) => (
                <a key={u} href={u} target="_blank" rel="noopener noreferrer"
                  title={`슬라이드 ${i + 1} 원본 열기`} style={{ flex: 'none', lineHeight: 0 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`슬라이드 ${i + 1}`} width={144} height={180}
                    style={{ width: 144, height: 180, objectFit: 'cover', borderRadius: 'var(--radius-2)' }} />
                </a>
              ))}
            </div>
            {row.slide_urls.length > 0 && (
              <p className="card-meta">슬라이드를 누르면 원본 크기로 열립니다 — 글자는 원본에서 확인하세요.</p>
            )}

            {row.caption && (
              <div className="field">
                <label htmlFor={`cap-${row.post_id}`}>캡션 (그대로 붙여넣으세요)</label>
                <textarea id={`cap-${row.post_id}`} className="input" rows={6} readOnly value={row.caption} />
              </div>
            )}

            {row.status === 'ready' && (row.bgm_suggestions?.length ?? 0) > 0 && (
              /* 음악은 인스타 앱 안에서만 붙일 수 있다 — 여기서는 검색창에 칠 곡을 추천만 한다.
                 추천이 없는 행(구 데이터·생성 실패)은 이 영역 자체가 없다(비차단 부가 기능). */
              <div className="field">
                <label>추천 음악 — 인스타 음악 검색창에 붙여넣으세요</label>
                <div className="stack" style={{ gap: 'var(--space-2)' }}>
                  {row.bgm_suggestions.map((b) => (
                    <div key={`${b.title}-${b.artist}`} className="row" style={{ gap: 'var(--space-2)', alignItems: 'baseline' }}>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ flex: 'none' }}
                        onClick={() => { void navigator.clipboard.writeText(`${b.title} ${b.artist}`); }}>
                        <Music size={14} /> 복사
                      </button>
                      <span style={{ minWidth: 0 }}>
                        <strong>{b.title}</strong> · {b.artist}
                        {b.mood && <span className="card-meta"> — {b.mood}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {row.status === 'ready' ? (
              <>
                <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary" onClick={() => void prepare(row)}>
                    <ExternalLink size={16} /> 인스타 열고 준비
                  </button>
                  <button type="button" className="btn btn-secondary"
                    onClick={() => { if (row.caption) void navigator.clipboard.writeText(row.caption); }}>
                    <Copy size={16} /> 캡션만 복사
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => downloadZip(row)}>
                    <Download size={16} /> 슬라이드 ZIP 받기
                  </button>
                </div>

                <div className="field">
                  <label htmlFor={`link-${row.post_id}`}>인스타에 올린 뒤, 게시물 링크를 붙여넣으세요</label>
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <input id={`link-${row.post_id}`} className="input" style={{ flex: 1 }}
                      placeholder="https://www.instagram.com/p/..."
                      value={links[row.post_id] ?? ''}
                      onChange={(e) => setLinks({ ...links, [row.post_id]: e.target.value })} />
                    <button type="button" className="btn btn-primary"
                      disabled={busy === row.post_id} onClick={() => void publish(row)}>
                      <Check size={16} /> 발행 완료
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {row.permalink && (
                  <a className="btn btn-secondary" href={row.permalink} target="_blank" rel="noopener noreferrer">
                    <ExternalLink size={16} /> 인스타에서 보기
                  </a>
                )}
                <button type="button" className="btn btn-secondary"
                  disabled={busy === row.post_id} onClick={() => void unpublish(row)}>
                  <Undo2 size={16} /> 발행 취소
                </button>
              </div>
            )}

            {note && (
              <p className="card-meta">
                {note.bad ? <X size={14} /> : <Check size={14} />} {note.text}
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="stack-6">
      <section className="stack">
        <h2 className="card-title">발행 대기 {ready.length > 0 && `(${ready.length})`}</h2>
        <p className="card-meta">
          인스타 캐러셀에 음악을 넣을 수 없어 발행은 사람이 합니다. 검수하고 올린 뒤 링크를 넣으면
          그때 사이트에 공개됩니다. 슬라이드는 순번 이름(01.jpg~)의 ZIP 한 파일로 내려받아집니다.
        </p>
        {ready.length === 0
          ? <p className="card-body">발행 대기 중인 카드뉴스가 없습니다.</p>
          : ready.map(card)}
      </section>

      <section className="stack">
        <h2 className="card-title">발행됨 {published.length > 0 && `(${published.length})`}</h2>
        {published.length === 0
          ? <p className="card-body">아직 발행된 카드뉴스가 없습니다.</p>
          : published.map(card)}
      </section>
    </div>
  );
}
