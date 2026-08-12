'use client';

import { useState } from 'react';
import { Palette } from 'lucide-react';
import { BackgroundRemovalStatus } from '@/types/editor';
import Empty from '@/components/state/Empty';
import Loading from '@/components/state/Loading';

interface BackgroundRemovalProps {
  status: BackgroundRemovalStatus;
  hasSelectedLayer: boolean;
  onRemove: () => void;
  onRemoveColor: (hex: string, tolerance: number) => void;
  onRestore: () => void;
}

// design-guard: 배경색 제거 알고리즘에 그대로 전달되는 색상 프리셋 값(픽셀 처리 데이터), UI 장식色 아님
const BG_COLORS = [
  { label: '흰색', value: '#ffffff' },
  { label: '검정', value: '#000000' },
];

export default function BackgroundRemoval({
  status,
  hasSelectedLayer,
  onRemove,
  onRemoveColor,
  onRestore,
}: BackgroundRemovalProps) {
  // design-guard: 배경색 제거 알고리즘 기본값(픽셀 처리 데이터), UI 장식色 아님
  const [selectedColor, setSelectedColor] = useState('#ffffff');
  const [tolerance, setTolerance] = useState(30);

  if (!hasSelectedLayer) {
    return <Empty title="레이어를 선택하세요" />;
  }

  if (status === 'processing') {
    return (
      <div className="card">
        <Loading label="처리 중... (최초 실행 시 AI 모델 다운로드로 시간이 걸립니다)" />
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="card stack-2">
        <div className="banner" data-tone="success">
          <span><b>배경 제거 완료</b></span>
        </div>
        <button type="button" className="btn btn-secondary btn-block" onClick={onRestore}>
          원본 복원
        </button>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="field">
        <label>배경색 제거</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {BG_COLORS.map((c) => {
            const isSelected = selectedColor === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={isSelected}
                aria-label={c.label}
                title={c.label}
                onClick={() => setSelectedColor(c.value)}
                className="btn btn-icon btn-pill"
                // design-guard: 배경색 제거 대상 스와치 미리보기(선택 가능한 픽셀 처리 값 그대로 표시), UI 장식色 아님
                style={{
                  backgroundColor: c.value,
                  border: isSelected ? '2px solid var(--color-accent)' : '1px solid var(--color-divider)',
                }}
              />
            );
          })}
          <div style={{ position: 'relative', width: 34, height: 34 }}>
            <input
              type="color"
              value={selectedColor}
              onChange={(e) => setSelectedColor(e.target.value)}
              title="커스텀 색상"
              aria-label="커스텀 색상"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
            />
            <div
              className="btn btn-icon btn-pill"
              aria-hidden
              style={{ pointerEvents: 'none' }}
            >
              <Palette size={16} aria-hidden />
            </div>
          </div>
        </div>

        <div className="row">
          <span className="text-muted">범위</span>
          <input
            type="range"
            className="range"
            min={5}
            max={80}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
          <span className="text-mono num" style={{ minWidth: 28 }}>{tolerance}</span>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => onRemoveColor(selectedColor, tolerance)}
        >
          배경색 제거
        </button>
      </div>

      <hr className="hr-thin" />

      <div className="field">
        <span className="text-muted">AI 배경 제거 (사물/인물용)</span>
        <button type="button" className="btn btn-secondary btn-block" onClick={onRemove}>
          AI 배경 제거
        </button>
      </div>
    </div>
  );
}
