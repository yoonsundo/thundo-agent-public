'use client';

// 인쇄 · PDF 버튼 — 브라우저 인쇄 대화상자를 연다(저장 시 PDF 선택 가능).
// 출력 시 자동 숨김은 부모의 [data-noprint] + @media print 규칙이 담당.
import { Printer } from 'lucide-react';

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      aria-label="인쇄 또는 PDF로 저장"
      className="btn btn-secondary btn-sm"
    >
      <Printer size={16} aria-hidden="true" />
      <span>인쇄 · PDF</span>
    </button>
  );
}
