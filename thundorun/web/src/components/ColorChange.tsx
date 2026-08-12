'use client';

import Empty from '@/components/state/Empty';

interface ColorChangeProps {
  isActive: boolean;
  currentColor: string | null;
  onChangeColor: (hex: string | null) => void;
}

// design-guard: 레이어 색상 변경 알고리즘에 그대로 전달되는 프리셋 값(픽셀 처리 데이터), UI 장식色 아님
const PRESET_COLORS = [
  { label: '흰색', value: '#ffffff' },
  { label: '검정', value: '#000000' },
  { label: '빨강', value: '#ef4444' },
  { label: '파랑', value: '#3b82f6' },
  { label: '초록', value: '#22c55e' },
  { label: '노랑', value: '#eab308' },
  { label: '주황', value: '#f97316' },
  { label: '보라', value: '#a855f7' },
  { label: '하늘', value: '#38bdf8' },
  { label: '회색', value: '#9ca3af' },
  { label: '형광 핑크', value: '#ff1493' },
  { label: '형광 초록', value: '#39ff14' },
  { label: '형광 노랑', value: '#ccff00' },
  { label: '형광 오렌지', value: '#ff6600' },
];

export default function ColorChange({
  isActive,
  currentColor,
  onChangeColor,
}: ColorChangeProps) {
  if (!isActive) {
    return <Empty title="배경 제거된 레이어를 선택하세요" />;
  }

  return (
    <div className="card stack-2">
      <span className="kicker">프리셋 색상</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {PRESET_COLORS.map((c) => {
          const isSelected = currentColor === c.value;
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={isSelected}
              aria-label={c.label}
              title={c.label}
              onClick={() => onChangeColor(c.value)}
              className="btn btn-icon btn-pill"
              // design-guard: 레이어 틴트 프리셋 스와치 미리보기(선택 가능한 픽셀 처리 값 그대로 표시), UI 장식色 아님
              style={{
                backgroundColor: c.value,
                border: isSelected ? '2px solid var(--color-accent)' : '1px solid var(--color-divider)',
              }}
            />
          );
        })}
      </div>

      <div className="field">
        <label htmlFor="custom-tint">커스텀</label>
        <input
          id="custom-tint"
          type="color"
          className="input"
          // design-guard: 색상 변경 알고리즘의 기본 폴백 값(픽셀 처리 데이터), UI 장식色 아님
          value={currentColor ?? '#ffffff'}
          onChange={(e) => onChangeColor(e.target.value)}
        />
      </div>

      <button type="button" className="btn btn-secondary btn-block" onClick={() => onChangeColor(null)}>
        원래 색상
      </button>
    </div>
  );
}
