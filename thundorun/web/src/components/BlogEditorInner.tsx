/**
 * BlogEditorInner.tsx — TipTap WYSIWYG 에디터 (관리자 블로그 편집, HTML in/out)
 * - content prop = HTML, onChangeContent(editor.getHTML()) 로 HTML 반출.
 * - 본문 영역은 키트 §11.3 `.article` — 블로그 조회 화면과 같은 타이포(WYSIWYG=실제화면).
 * - 툴바는 키트 §4.7 `.toolbar` + `.btn .btn-icon`(lucide 아이콘 + aria-label/aria-pressed, §8).
 * - StarterKit 의 내장 Link 는 비활성하고 standalone Link/Image 확장을 명시 사용.
 * - 'use client' + 부모(BlogEditor)에서 dynamic ssr:false 로 마운트(SSR 이슈 회피).
 */
'use client';

import { useEffect } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import {
  Bold, Code, Heading2, Heading3, Image as ImageIcon, Italic,
  Link2, List, ListOrdered, Quote,
} from 'lucide-react';

interface Props {
  initialValue?: string;
  onChangeContent: (content: string) => void;
}

/**
 * 툴바 토글 버튼.
 * 활성 표시는 `aria-pressed`(의미) + 키트 `.btn-ghost`(강조색 글자 — 새 CSS 없이 시각 구분).
 */
function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={['btn', 'btn-icon', 'tooltip', active ? 'btn-ghost' : ''].join(' ')}
      aria-label={label}
      aria-pressed={active}
      data-tip={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const addLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('링크 URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const addImage = () => {
    const url = window.prompt('이미지 URL', 'https://');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="본문 서식">
      <ToolbarButton label="제목 H2" active={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={18} />
      </ToolbarButton>
      <ToolbarButton label="제목 H3" active={editor.isActive('heading', { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={18} />
      </ToolbarButton>

      <span className="nav-divider" />

      <ToolbarButton label="굵게" active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={18} />
      </ToolbarButton>
      <ToolbarButton label="기울임" active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={18} />
      </ToolbarButton>

      <span className="nav-divider" />

      <ToolbarButton label="글머리 목록" active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={18} />
      </ToolbarButton>
      <ToolbarButton label="번호 목록" active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={18} />
      </ToolbarButton>
      <ToolbarButton label="인용" active={editor.isActive('blockquote')}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <Quote size={18} />
      </ToolbarButton>
      <ToolbarButton label="코드 블록" active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <Code size={18} />
      </ToolbarButton>

      <span className="nav-divider" />

      <ToolbarButton label="링크" active={editor.isActive('link')} onClick={addLink}>
        <Link2 size={18} />
      </ToolbarButton>
      <ToolbarButton label="이미지" onClick={addImage}>
        <ImageIcon size={18} />
      </ToolbarButton>
    </div>
  );
}

export default function BlogEditorInner({ initialValue = '', onChangeContent }: Props) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
    ],
    content: initialValue,
    editorProps: {
      attributes: {
        // 본문 타이포는 키트 `.article` 하나로 통일(조회 화면과 동일).
        // 클릭 가능한 최소 높이는 치수 보정(§12.5).
        class: 'article',
        style: 'min-height:420px',
      },
    },
    onUpdate: ({ editor: ed }) => onChangeContent(ed.getHTML()),
  });

  // key={slug} 로 부모가 재마운트하지만, 안전망: initialValue 변경 시 동기화
  useEffect(() => {
    if (editor && initialValue !== editor.getHTML()) {
      editor.commands.setContent(initialValue, { emitUpdate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="card card-outline">
      {editor && <Toolbar editor={editor} />}
      <div className="scroll-y" style={{ maxHeight: '70vh' }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
