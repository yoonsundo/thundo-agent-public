'use client';

import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Layer } from '@/types/editor';

interface LayerListProps {
  layers: Layer[];
  selectedLayerId: string | null;
  onSelectLayer: (id: string) => void;
  onRemoveLayer: (id: string) => void;
  onReorderLayer: (fromIndex: number, toIndex: number) => void;
}

export default function LayerList({
  layers,
  selectedLayerId,
  onSelectLayer,
  onRemoveLayer,
  onReorderLayer,
}: LayerListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragStartX = useRef(0);
  const dragging = useRef(false);

  if (layers.length === 0) return null;

  const handlePointerDown = (e: React.PointerEvent, index: number) => {
    dragStartX.current = e.clientX;
    dragging.current = false;
    setDragIndex(index);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragIndex === null) return;
    const dx = Math.abs(e.clientX - dragStartX.current);
    if (dx > 10) dragging.current = true;
    if (!dragging.current) return;

    // 현재 hover 중인 인덱스 계산
    const container = (e.target as HTMLElement).closest('[data-layer-list]');
    if (!container) return;
    const children = Array.from(container.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right) {
        setOverIndex(i);
        break;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent, index: number) => {
    if (dragging.current && dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      onReorderLayer(dragIndex, overIndex);
    } else if (!dragging.current) {
      onSelectLayer(layers[index].id);
    }
    setDragIndex(null);
    setOverIndex(null);
    dragging.current = false;
  };

  return (
    <div
      data-layer-list
      className="row"
      style={{
        padding: 'var(--space-2) var(--space-4)',
        overflowX: 'auto',
        background: 'var(--color-surface)',
        touchAction: 'none',
      }}
    >
      {layers.map((layer, i) => {
        const isSelected = layer.id === selectedLayerId;
        const isDragging = dragIndex === i && dragging.current;
        const isOver = overIndex === i && dragIndex !== null && dragIndex !== i;

        return (
          <div
            key={layer.id}
            style={{
              position: 'relative',
              flexShrink: 0,
              transition: 'transform .15s ease',
              transform: isDragging ? 'scale(0.9)' : isOver ? 'scale(1.1)' : undefined,
              opacity: isDragging ? 0.5 : 1,
            }}
          >
            {isOver && (
              <div
                style={{
                  position: 'absolute', left: -4, top: 0, bottom: 0, width: 2,
                  background: 'var(--color-accent)', borderRadius: 'var(--radius-pill)',
                }}
              />
            )}
            <div
              aria-current={isSelected || undefined}
              style={{
                width: 44, height: 44, borderRadius: 'var(--radius-md)', overflow: 'hidden',
                border: isSelected ? '2px solid var(--color-accent)' : '1px solid var(--color-hairline)',
                opacity: isSelected ? 1 : 0.7,
              }}
              onPointerDown={(e) => handlePointerDown(e, i)}
              onPointerMove={(e) => handlePointerMove(e)}
              onPointerUp={(e) => handlePointerUp(e, i)}
            >
              <img
                src={layer.image.src}
                alt={`레이어 ${i + 1}`}
                style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
                draggable={false}
              />
            </div>
            {isSelected && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveLayer(layer.id);
                }}
                className="btn btn-icon"
                style={{
                  position: 'absolute', top: -8, right: -8, width: 22, height: 22, minHeight: 0,
                  padding: 0, borderRadius: 'var(--radius-pill)', borderColor: 'transparent',
                  background: 'var(--color-danger-solid)', color: 'var(--color-on-danger)',
                  boxShadow: 'var(--shadow-sm)',
                }}
                aria-label={`레이어 ${i + 1} 삭제`}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
