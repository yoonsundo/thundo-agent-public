/**
 * EditorHeader.tsx — 이미지 편집기(/run) 상단바.
 * Modernist Kit §4.1 `.topbar` — 아이콘 버튼은 lucide + aria-label(§8).
 */
'use client';

import { ArrowLeft } from 'lucide-react';

interface EditorHeaderProps {
  onBack: () => void;
  onSave: () => void;
}

export default function EditorHeader({ onBack, onSave }: EditorHeaderProps) {
  return (
    // iPhone 홈화면추가(standalone) 안전영역 — §11.2 `.pt-safe`.
    // (`.topbar` 자체에 주면 고정 높이 56px 안쪽을 잡아먹어 래퍼에 준다.)
    <div className="pt-safe">
      <header className="topbar">
        {/* 뒤로 = ArrowLeft 16 (§12.9 글리프 매핑) */}
        <button type="button" className="btn btn-icon" onClick={onBack} aria-label="편집기 나가기">
          <ArrowLeft size={16} />
        </button>
        <span className="topbar-title">TH-BOX</span>
        <div className="spacer" />
        <button type="button" className="btn btn-primary" onClick={onSave}>
          저장
        </button>
      </header>
    </div>
  );
}
