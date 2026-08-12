'use client';

import { useRef, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { Layer, ASPECT_PRESETS, EditorTab } from '@/types/editor';

interface LayerCanvasProps {
  layers: Layer[];
  selectedLayerId: string | null;
  selectedPreset: number;
  activeTab: EditorTab;
  eraserSize: number;
  canvasAreaRef: React.RefObject<HTMLDivElement | null>;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  onSelectLayer: (id: string | null) => void;
  onUpdateLayer: (id: string, updates: Partial<Layer>) => void;
  onAddFile: (file: File) => void;
  onStartEraser: (layerId: string) => void;
  onApplyEraser: (from: { x: number; y: number }, to: { x: number; y: number }) => void;
}

export default function LayerCanvas({
  layers,
  selectedLayerId,
  selectedPreset,
  activeTab,
  canvasAreaRef,
  workspaceRef,
  onSelectLayer,
  onUpdateLayer,
  onAddFile,
  onStartEraser,
  onApplyEraser,
}: LayerCanvasProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eraserPoints = useRef<{ x: number; y: number }[]>([]);
  const isErasing = useRef(false);
  const pinchState = useRef<{ startDist: number; startW: number; startH: number; layerId: string } | null>(null);
  const dragState = useRef<{
    type: 'move' | 'resize';
    layerId: string;
    startX: number;
    startY: number;
    startLayerX: number;
    startLayerY: number;
    startLayerW: number;
    startLayerH: number;
  } | null>(null);

  const preset = ASPECT_PRESETS[selectedPreset];

  const getPointerPos = useCallback((e: React.PointerEvent | PointerEvent) => {
    // 좌표계 = 작업공간(어두운 영역 전체). 크롭 프레임 밖으로도 옮길 수 있어야 한다.
    const rect = workspaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, [workspaceRef]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, layerId: string, type: 'move' | 'resize') => {
      e.stopPropagation();
      e.preventDefault();
      const pos = getPointerPos(e);
      const layer = layers.find((l) => l.id === layerId);
      if (!layer) return;

      onSelectLayer(layerId);

      // 지우개 모드
      if (activeTab === 'eraser' && type === 'move') {
        const localX = pos.x - layer.x;
        const localY = pos.y - layer.y;
        const pt = { x: localX, y: localY };
        eraserPoints.current = [pt];
        isErasing.current = true;
        onStartEraser(layerId);
        onApplyEraser(pt, pt);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        return;
      }

      dragState.current = {
        type,
        layerId,
        startX: pos.x,
        startY: pos.y,
        startLayerX: layer.x,
        startLayerY: layer.y,
        startLayerW: layer.width,
        startLayerH: layer.height,
      };

      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [layers, onSelectLayer, getPointerPos, activeTab]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // 지우개 모드
      if (isErasing.current && selectedLayerId) {
        e.preventDefault();
        const pos = getPointerPos(e);
        const layer = layers.find((l) => l.id === selectedLayerId);
        if (layer) {
          const localX = pos.x - layer.x;
          const localY = pos.y - layer.y;
          const prevPt = eraserPoints.current[eraserPoints.current.length - 1];
          const curPt = { x: localX, y: localY };
          onApplyEraser(prevPt, curPt);
          eraserPoints.current.push(curPt);
        }
        return;
      }

      const state = dragState.current;
      if (!state) return;
      e.preventDefault();

      const pos = getPointerPos(e);
      const dx = pos.x - state.startX;
      const dy = pos.y - state.startY;

      if (state.type === 'move') {
        // 최소 30px은 캔버스 안에 유지
        const area = canvasAreaRef.current;
        const areaW = area?.clientWidth ?? 9999;
        const areaH = area?.clientHeight ?? 9999;
        const layer = layers.find((l) => l.id === state.layerId);
        if (!layer) return;
        const newX = state.startLayerX + dx;
        const newY = state.startLayerY + dy;
        onUpdateLayer(state.layerId, {
          x: Math.max(-layer.width + 30, Math.min(areaW - 30, newX)),
          y: Math.max(-layer.height + 30, Math.min(areaH - 30, newY)),
        });
      } else {
        onUpdateLayer(state.layerId, {
          width: Math.max(30, state.startLayerW + dx),
          height: Math.max(30, state.startLayerH + dy),
        });
      }
    },
    [onUpdateLayer, getPointerPos, canvasAreaRef, layers]
  );

  const handlePointerUp = useCallback(() => {
    if (isErasing.current) {
      eraserPoints.current = [];
      isErasing.current = false;
      return;
    }
    dragState.current = null;
  }, []);

  // 핀치 줌: 두 손가락으로 레이어 리사이즈
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && selectedLayerId) {
      e.preventDefault();
      const layer = layers.find((l) => l.id === selectedLayerId);
      if (!layer) return;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      pinchState.current = { startDist: dist, startW: layer.width, startH: layer.height, layerId: selectedLayerId };
    }
  }, [selectedLayerId, layers]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchState.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const scale = dist / pinchState.current.startDist;
      onUpdateLayer(pinchState.current.layerId, {
        width: Math.max(30, pinchState.current.startW * scale),
        height: Math.max(30, pinchState.current.startH * scale),
      });
    }
  }, [onUpdateLayer]);

  const handleTouchEnd = useCallback(() => {
    pinchState.current = null;
  }, []);

  const pad = 40;
  const canvasStyle: React.CSSProperties = preset.ratio
    ? preset.ratio < 1
      // 세로 비율 (스토리, TikTok 등): 높이 기준으로 채움
      ? { aspectRatio: `${preset.ratio}`, height: `calc(100% - ${pad * 2}px)`, maxWidth: `calc(100% - ${pad * 2}px)` }
      // 가로/정방 비율: 너비 기준으로 채움
      : { aspectRatio: `${preset.ratio}`, width: `calc(100% - ${pad * 2}px)`, maxHeight: `calc(100% - ${pad * 2}px)` }
    : { width: `calc(100% - ${pad * 2}px)`, height: `calc(100% - ${pad * 2}px)` };

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'none',
        cursor: activeTab === 'eraser' ? 'crosshair' : 'default',
      }}
      ref={workspaceRef as React.LegacyRef<HTMLDivElement>}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={(e) => {
        if (e.target === e.currentTarget || e.target === canvasAreaRef.current) {
          onSelectLayer(null);
        }
      }}
    >
      {/* 크롭 프레임 = 저장될 영역. 사진은 이 밖(작업공간)으로도 자유롭게 옮길 수 있고,
          저장 시 프레임 안쪽만 잘려 나간다. 프레임은 클릭을 가로채지 않는다. */}
      <div
        ref={canvasAreaRef as React.LegacyRef<HTMLDivElement>}
        className="canvas-stage checkerboard"
        style={{ ...canvasStyle, position: 'relative', overflow: 'visible', pointerEvents: 'none' }}
      >
        {/* 경계선 + 바깥 딤 — 이미지 위에 항상 보이도록 z 50.
            box-shadow 확산으로 프레임 밖을 덮어 '저장되지 않는 영역'을 드러낸다. */}
        <div className="crop-guide" />
        {layers.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p className="text-muted">사진을 추가하세요</p>
          </div>
        )}
      </div>

        {layers.map((layer) => {
          const isSelected = layer.id === selectedLayerId;
          return (
            <div
              key={layer.id}
              style={{ position: 'absolute', left: layer.x, top: layer.y, width: layer.width, height: layer.height }}
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={layer.image.src}
                alt=""
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'fill',
                  userSelect: 'none',
                  filter: [
                    `brightness(${1 + layer.brightness / 100})`,
                    `contrast(${1 + layer.contrast / 100})`,
                    `saturate(${1 + layer.saturation / 100})`,
                  ].join(' '),
                }}
                onPointerDown={(e) => handlePointerDown(e, layer.id, 'move')}
              />
              {isSelected && (
                <>
                  <div
                    style={{
                      position: 'absolute', inset: 0, pointerEvents: 'none',
                      border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-sm)',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute', bottom: -12, right: -12, width: 32, height: 32,
                      background: 'var(--color-accent)', border: '2px solid var(--color-surface-raised)',
                      borderRadius: 'var(--radius-pill)', cursor: 'se-resize', touchAction: 'none',
                      boxShadow: 'var(--shadow-md)',
                    }}
                    onPointerDown={(e) => handlePointerDown(e, layer.id, 'resize')}
                  />
                </>
              )}
            </div>
          );
        })}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fileInputRef.current?.click();
        }}
        className="btn btn-secondary btn-icon btn-pill"
        style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10 }}
        aria-label="사진 추가"
      >
        <Plus size={18} aria-hidden />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onAddFile(file);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }}
        className="sr-only"
      />
    </div>
  );
}
