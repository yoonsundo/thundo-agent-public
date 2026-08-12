'use client';

// BlogSearch — 목록 페이지 검색 입력. 제출 시 ?q= 로 이동(force-dynamic 서버가 재필터).
// 태그 필터는 서버 링크로 별도 관리 — 검색 시 현재 tag 를 유지한다.
// 네비게이션이 완료되기 전까지는 useTransition 의 pending 상태로 로딩을 알린다(DESIGN.md §6).
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Search } from 'lucide-react';
import Loading from '@/components/state/Loading';

export default function BlogSearch({ initialQuery = '', tag = '' }: { initialQuery?: string; tag?: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (tag) params.set('tag', tag);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/blog?${qs}` : '/blog');
    });
  }

  return (
    <div className="stack-2">
      <form onSubmit={submit} className="toolbar" role="search">
        <Search size={18} aria-hidden="true" className="text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="제목·내용 검색"
          aria-label="블로그 검색"
          className="input"
        />
      </form>
      {isPending && <Loading label="검색 중…" />}
    </div>
  );
}
