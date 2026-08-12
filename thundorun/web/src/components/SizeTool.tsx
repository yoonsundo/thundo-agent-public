'use client';

import { ASPECT_PRESETS } from '@/types/editor';

interface SizeToolProps {
  selectedPreset: number;
  onPresetChange: (v: number) => void;
}

export default function SizeTool({
  selectedPreset,
  onPresetChange,
}: SizeToolProps) {
  return (
    <div className="card">
      <span className="kicker">캔버스 비율</span>
      <div className="grid-auto-sm">
        {ASPECT_PRESETS.map((preset, i) => {
          const isSelected = selectedPreset === i;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onPresetChange(i)}
              className="btn btn-secondary btn-sm"
              style={
                isSelected
                  ? {
                      background: 'var(--color-accent-100)',
                      borderColor: 'var(--color-accent)',
                      color: 'var(--color-accent-700)',
                    }
                  : undefined
              }
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
