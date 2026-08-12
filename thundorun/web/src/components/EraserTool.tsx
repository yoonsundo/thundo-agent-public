'use client';

import Empty from '@/components/state/Empty';

interface EraserToolProps {
  hasSelectedLayer: boolean;
  eraserSize: number;
  onSizeChange: (size: number) => void;
  onRestore: () => void;
}

export default function EraserTool({
  hasSelectedLayer,
  eraserSize,
  onSizeChange,
  onRestore,
}: EraserToolProps) {
  if (!hasSelectedLayer) {
    return <Empty title="레이어를 선택하세요" />;
  }

  return (
    <div className="card stack-2">
      <div className="field">
        <label htmlFor="eraser-size">지우개 크기</label>
        <div className="row">
          <input
            id="eraser-size"
            type="range"
            className="range"
            min={5}
            max={80}
            value={eraserSize}
            onChange={(e) => onSizeChange(Number(e.target.value))}
          />
          <span className="text-mono num" style={{ minWidth: 28 }}>{eraserSize}</span>
        </div>
      </div>

      <button type="button" className="btn btn-secondary btn-block" onClick={onRestore}>
        원본 복원
      </button>
    </div>
  );
}
