export type EditorTab = 'size' | 'background' | 'eraser' | 'color-change' | 'correction';

export type BackgroundRemovalStatus = 'idle' | 'processing' | 'done';

export interface Layer {
  id: string;
  image: HTMLImageElement;
  originalImage: HTMLImageElement; // 원본 보존
  x: number;
  y: number;
  width: number;
  height: number;
  bgRemoved: boolean;
  colorTint: string | null; // null = 원래 색상, '#ffffff' 등
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export interface AspectPreset {
  label: string;
  ratio: number | null;
  resolution?: { width: number; height: number };
}

export const ASPECT_PRESETS: AspectPreset[] = [
  { label: 'Free', ratio: null },
  { label: '스토리', ratio: 9 / 16, resolution: { width: 1080, height: 1920 } },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:5', ratio: 4 / 5 },
  { label: 'YouTube', ratio: 16 / 9, resolution: { width: 1280, height: 720 } },
  { label: 'TikTok', ratio: 9 / 16, resolution: { width: 1080, height: 1920 } },
];

export const DEFAULT_LAYER_CORRECTIONS = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 6500,
  tint: 0,
};
