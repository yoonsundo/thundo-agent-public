'use client';

import { Layer } from '@/types/editor';
import Empty from '@/components/state/Empty';

interface ColorCorrectionProps {
  layer: Layer | null;
  onUpdate: (key: string, value: number) => void;
  onReset: () => void;
}

function Slider({
  label,
  htmlId,
  value,
  min,
  max,
  step,
  displayValue,
  onChange,
}: {
  label: string;
  htmlId: string;
  value: number;
  min: number;
  max: number;
  step: number;
  displayValue: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlId}>{label}</label>
      <div className="row">
        <input
          id={htmlId}
          type="range"
          className="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="text-mono num" style={{ minWidth: 44 }}>{displayValue}</span>
      </div>
    </div>
  );
}

export default function ColorCorrection({
  layer,
  onUpdate,
  onReset,
}: ColorCorrectionProps) {
  if (!layer) {
    return <Empty title="레이어를 선택하세요" />;
  }

  return (
    <div className="card stack-2">
      <Slider
        label="밝기"
        htmlId="corr-brightness"
        value={layer.brightness}
        min={-100}
        max={100}
        step={1}
        displayValue={`${layer.brightness}`}
        onChange={(v) => onUpdate('brightness', v)}
      />
      <Slider
        label="대비"
        htmlId="corr-contrast"
        value={layer.contrast}
        min={-100}
        max={100}
        step={1}
        displayValue={`${layer.contrast}`}
        onChange={(v) => onUpdate('contrast', v)}
      />
      <Slider
        label="채도"
        htmlId="corr-saturation"
        value={layer.saturation}
        min={-100}
        max={100}
        step={1}
        displayValue={`${layer.saturation}`}
        onChange={(v) => onUpdate('saturation', v)}
      />
      <Slider
        label="색온도"
        htmlId="corr-temperature"
        value={layer.temperature}
        min={2000}
        max={10000}
        step={100}
        displayValue={`${layer.temperature}K`}
        onChange={(v) => onUpdate('temperature', v)}
      />
      <Slider
        label="틴트"
        htmlId="corr-tint"
        value={layer.tint}
        min={-150}
        max={150}
        step={1}
        displayValue={`${layer.tint}`}
        onChange={(v) => onUpdate('tint', v)}
      />
      <button type="button" className="btn btn-secondary btn-block" onClick={onReset}>
        초기화
      </button>
    </div>
  );
}
