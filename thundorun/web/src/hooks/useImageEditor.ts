'use client';

import { useState, useCallback, useRef } from 'react';
import {
  EditorTab,
  Layer,
  BackgroundRemovalStatus,
  ASPECT_PRESETS,
  DEFAULT_LAYER_CORRECTIONS,
} from '@/types/editor';
import { removeImageBackground, blobToImageElement, canvasToBlob } from '@/lib/backgroundRemoval';
import { applyColorTint, applyColorCorrection, removeColorBackground } from '@/lib/imageProcessor';

let layerIdCounter = 0;
function genId() {
  return `layer-${++layerIdCounter}`;
}

export function useImageEditor() {
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>('size');
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [bgRemovalStatus, setBgRemovalStatus] = useState<BackgroundRemovalStatus>('idle');
  const [eraserSize, setEraserSize] = useState(20);

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  // 편집 작업공간(전체 어두운 영역). 레이어 좌표의 기준계다 — 크롭 프레임 밖으로도 자유롭게 옮긴다.
  const workspaceRef = useRef<HTMLDivElement>(null);

  const selectedLayer = layers.find((l) => l.id === selectedLayerId) ?? null;

  const addLayer = useCallback((file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      // blob URL은 revoke하지 않음 — LayerCanvas에서 img.src로 렌더링에 필요
      const id = genId();
      const scale = Math.min(300 / img.width, 300 / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      // 좌표는 작업공간 기준이므로, 새 사진은 크롭 프레임(빨간 가이드) 한가운데에 놓는다.
      const frameEl = canvasAreaRef.current;
      const wsEl = workspaceRef.current;
      let x = 50;
      let y = 50;
      if (frameEl && wsEl) {
        const f = frameEl.getBoundingClientRect();
        const r = wsEl.getBoundingClientRect();
        x = f.left - r.left + (f.width - w) / 2;
        y = f.top - r.top + (f.height - h) / 2;
      }
      const newLayer: Layer = {
        id,
        image: img,
        originalImage: img,
        x,
        y,
        width: w,
        height: h,
        bgRemoved: false,
        colorTint: null,
        ...DEFAULT_LAYER_CORRECTIONS,
      };
      setLayers((prev) => [...prev, newLayer]);
      setSelectedLayerId(id);
    };
    img.src = url;
  }, []);

  const updateLayer = useCallback((id: string, updates: Partial<Layer>) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...updates } : l))
    );
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const layer = prev.find((l) => l.id === id);
      if (layer?.originalImage.src.startsWith('blob:')) {
        URL.revokeObjectURL(layer.originalImage.src);
      }
      return prev.filter((l) => l.id !== id);
    });
    setSelectedLayerId((prev) => (prev === id ? null : prev));
  }, []);

  const reorderLayer = useCallback((fromIndex: number, toIndex: number) => {
    setLayers((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const removeBackground = useCallback(async () => {
    if (!selectedLayer) return;
    setBgRemovalStatus('processing');
    try {
      const img = selectedLayer.originalImage;
      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imgW;
      tempCanvas.height = imgH;
      const ctx = tempCanvas.getContext('2d');
      if (!ctx) {
        setBgRemovalStatus('idle');
        return;
      }
      ctx.drawImage(img, 0, 0, imgW, imgH);

      const blob = await canvasToBlob(tempCanvas);
      const resultBlob = await removeImageBackground(blob);
      const resultImage = await blobToImageElement(resultBlob);

      updateLayer(selectedLayer.id, {
        image: resultImage,
        bgRemoved: true,
      });
      setBgRemovalStatus('done');
    } catch (error) {
      console.error('[TH-BOX] AI 배경 제거 실패:', error);
      console.error('[TH-BOX] 에러 메시지:', error instanceof Error ? error.message : String(error));
      console.error('[TH-BOX] 스택:', error instanceof Error ? error.stack : 'N/A');
      setBgRemovalStatus('idle');
    }
  }, [selectedLayer, updateLayer]);

  // 색상 기반 배경 제거
  const removeColorBg = useCallback((targetColor: string, tolerance: number) => {
    if (!selectedLayer) return;
    setBgRemovalStatus('processing');
    try {
      const resultCanvas = removeColorBackground(
        selectedLayer.originalImage,
        targetColor,
        tolerance
      );
      const dataUrl = resultCanvas.toDataURL('image/png');
      const img = new Image();
      img.onload = () => {
        updateLayer(selectedLayer.id, {
          image: img,
          bgRemoved: true,
        });
        setBgRemovalStatus('done');
      };
      img.src = dataUrl;
    } catch (error) {
      console.error('Color background removal failed:', error);
      setBgRemovalStatus('idle');
    }
  }, [selectedLayer, updateLayer]);

  const restoreOriginal = useCallback(() => {
    if (!selectedLayer) return;
    updateLayer(selectedLayer.id, {
      image: selectedLayer.originalImage,
      bgRemoved: false,
      colorTint: null,
    });
    setBgRemovalStatus('idle');
  }, [selectedLayer, updateLayer]);

  const changeColor = useCallback((color: string | null) => {
    if (!selectedLayer || !selectedLayer.bgRemoved) return;

    if (color === null) {
      // 원래 색상 복원 — bgRemoved 상태에서 원본 배경제거 다시
      // 간단히 colorTint만 null로
      updateLayer(selectedLayer.id, { colorTint: null });
      return;
    }

    const tintedImage = applyColorTint(selectedLayer.image, color);
    if (tintedImage) {
      const img = new Image();
      img.onload = () => {
        updateLayer(selectedLayer.id, { image: img, colorTint: color });
      };
      img.src = tintedImage;
    }
  }, [selectedLayer, updateLayer]);

  const updateCorrection = useCallback((key: string, value: number) => {
    if (!selectedLayer) return;
    updateLayer(selectedLayer.id, { [key]: value });
  }, [selectedLayer, updateLayer]);

  const resetCorrection = useCallback(() => {
    if (!selectedLayer) return;
    updateLayer(selectedLayer.id, DEFAULT_LAYER_CORRECTIONS);
  }, [selectedLayer, updateLayer]);

  // 지우개용 offscreen canvas — 레이어별로 유지
  const eraserCanvasRef = useRef<{ layerId: string; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);

  // 지우개 시작: offscreen canvas 초기화
  const startEraser = useCallback((layerId: string) => {
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) return;

    const canvas = document.createElement('canvas');
    canvas.width = layer.image.naturalWidth || layer.image.width;
    canvas.height = layer.image.naturalHeight || layer.image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(layer.image, 0, 0);
    eraserCanvasRef.current = { layerId, canvas, ctx };
  }, [layers]);

  // 지우개: from→to 선분을 offscreen canvas에 즉시 그리고 img.src 갱신
  const applyEraser = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    if (!selectedLayer) return;
    const ec = eraserCanvasRef.current;
    if (!ec || ec.layerId !== selectedLayer.id) return;

    const { canvas, ctx } = ec;
    const scaleX = canvas.width / selectedLayer.width;
    const scaleY = canvas.height / selectedLayer.height;

    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = eraserSize * Math.max(scaleX, scaleY);

    ctx.beginPath();
    ctx.moveTo(from.x * scaleX, from.y * scaleY);
    ctx.lineTo(to.x * scaleX, to.y * scaleY);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';

    // 동기적으로 data URL 생성 → 즉시 반영
    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => {
      updateLayer(selectedLayer.id, { image: newImg });
    };
    newImg.src = dataUrl;
  }, [selectedLayer, eraserSize, updateLayer]);

  const save = useCallback(() => {
    if (layers.length === 0) return;

    const preset = ASPECT_PRESETS[selectedPreset];
    const areaEl = canvasAreaRef.current;
    const containerW = areaEl?.clientWidth ?? 400;
    const containerH = areaEl?.clientHeight ?? 600;

    // 레이어 좌표는 '작업공간' 기준이고 저장 대상은 '크롭 프레임'(빨간 가이드) 안쪽뿐이다.
    // 두 좌표계의 차이를 빼야 프레임에 보이는 그대로 저장된다.
    let frameX = 0;
    let frameY = 0;
    const wsEl = workspaceRef.current;
    if (areaEl && wsEl) {
      const f = areaEl.getBoundingClientRect();
      const r = wsEl.getBoundingClientRect();
      frameX = f.left - r.left;
      frameY = f.top - r.top;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 프리셋에 고정 해상도가 있으면 해당 해상도, 아니면 화면 크기 × DPR
    let outputW: number;
    let outputH: number;
    if (preset.resolution) {
      outputW = preset.resolution.width;
      outputH = preset.resolution.height;
    } else {
      const dpr = Math.max(window.devicePixelRatio || 1, 2);
      outputW = containerW * dpr;
      outputH = containerH * dpr;
    }

    const scaleX = outputW / containerW;
    const scaleY = outputH / containerH;

    canvas.width = outputW;
    canvas.height = outputH;
    ctx.clearRect(0, 0, outputW, outputH);

    for (const layer of layers) {
      // 이미지를 임시 캔버스에 원본 크기로 그리기
      const imgW = layer.image.naturalWidth || layer.image.width;
      const imgH = layer.image.naturalHeight || layer.image.height;
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imgW;
      tempCanvas.height = imgH;
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) continue;
      tempCtx.drawImage(layer.image, 0, 0, imgW, imgH);

      // 색보정 적용
      const corrected = applyColorCorrection(tempCanvas, {
        brightness: layer.brightness,
        contrast: layer.contrast,
        saturation: layer.saturation,
        temperature: layer.temperature,
        tint: layer.tint,
      });

      // 레이어 영역에 맞게 그리기 — 출력 해상도에 맞게 스케일
      ctx.drawImage(
        corrected,
        (layer.x - frameX) * scaleX,
        (layer.y - frameY) * scaleY,
        layer.width * scaleX,
        layer.height * scaleY,
      );
    }

    // canvas → Blob → File
    canvas.toBlob(async (blob) => {
      if (!blob) return;

      const file = new File([blob], 'th-box-edited.png', { type: 'image/png' });

      // Web Share API 사용 (iOS Safari → 공유 시트 → "사진에 저장")
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (e) {
          // 사용자가 취소하면 무시
          if ((e as Error).name === 'AbortError') return;
        }
      }

      // 폴백: 데스크톱 다운로드
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = 'th-box-edited.png';
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }, [layers, selectedPreset]);

  return {
    layers,
    selectedLayer,
    selectedLayerId,
    setSelectedLayerId,
    activeTab,
    setActiveTab,
    selectedPreset,
    setSelectedPreset,
    bgRemovalStatus,
    canvasAreaRef,
    workspaceRef,
    addLayer,
    updateLayer,
    removeLayer,
    reorderLayer,
    removeBackground,
    removeColorBg,
    restoreOriginal,
    changeColor,
    updateCorrection,
    resetCorrection,
    eraserSize,
    setEraserSize,
    startEraser,
    applyEraser,
    save,
  };
}
