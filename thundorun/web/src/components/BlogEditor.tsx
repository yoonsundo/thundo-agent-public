/**
 * BlogEditor.tsx — 관리자 블로그 편집기 (TipTap WYSIWYG, HTML in/out)
 * - 실제 에디터는 BlogEditorInner.tsx. 여기서는 dynamic ssr:false 로만 마운트해
 *   ProseMirror 의 SSR 이슈를 회피한다.
 * - props 계약(initialValue, onChangeContent)은 기존과 동일 — AdminDashboard 무변경 호환.
 * - 로딩 상태는 키트 §4.14(`.spinner`) — components/state/Loading 재사용.
 */
'use client';

import dynamic from 'next/dynamic';
import Loading from '@/components/state/Loading';

const BlogEditorInner = dynamic(() => import('@/components/BlogEditorInner'), {
  ssr:     false,
  // 로딩 골격은 완성 화면과 같은 높이를 유지한다(레이아웃 점프 금지, §4.14).
  loading: () => (
    <div className="card card-outline" style={{ height: 520 }}>
      <Loading label="에디터 로딩 중…" />
    </div>
  ),
});

interface Props {
  initialValue?: string;
  onChangeContent: (content: string) => void;
}

export default function BlogEditor({ initialValue = '', onChangeContent }: Props) {
  return <BlogEditorInner initialValue={initialValue} onChangeContent={onChangeContent} />;
}
