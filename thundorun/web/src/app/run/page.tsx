'use client';

import { useState, useRef } from 'react';
import { useImageEditor } from '@/hooks/useImageEditor';
import EditorHeader from '@/components/EditorHeader';
import LayerCanvas from '@/components/LayerCanvas';
import LayerList from '@/components/LayerList';
import SizeTool from '@/components/SizeTool';
import BackgroundRemoval from '@/components/BackgroundRemoval';
import EraserTool from '@/components/EraserTool';
import ColorChange from '@/components/ColorChange';
import ColorCorrection from '@/components/ColorCorrection';
import TabBar from '@/components/TabBar';
import { ImagePlus } from 'lucide-react';

export default function RunPage() {
  const [started, setStarted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editor = useImageEditor();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    editor.addLayer(file);
    setStarted(true);
  };

  if (!started) {
    return (
      // 이전 동작 복원(2026-07-30 사용자 요청) — 클릭하면 바로 전체화면 런처.
      // 리팩토링 중 page-head+설명 카드가 끼어 단계가 늘어난 것을 되돌린다.
      // 표현은 킷 토큰만 사용(Tailwind 재도입 금지).
      <div className="launcher">
        <p className="kicker">도구함</p>
        <h1 className="page-title">TH-BOX</h1>
        <p className="page-sub">사진 편집기</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus size={18} aria-hidden="true" />
          사진 선택
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="sr-only"
        />
      </div>
    );
  }


  return (
    <div
      className="no-overscroll"
      style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}
    >
      <EditorHeader
        onBack={() => setStarted(false)}
        onSave={editor.save}
      />

      <LayerCanvas
        layers={editor.layers}
        selectedLayerId={editor.selectedLayerId}
        selectedPreset={editor.selectedPreset}
        activeTab={editor.activeTab}
        eraserSize={editor.eraserSize}
        canvasAreaRef={editor.canvasAreaRef}
        workspaceRef={editor.workspaceRef}
        onSelectLayer={editor.setSelectedLayerId}
        onUpdateLayer={editor.updateLayer}
        onAddFile={editor.addLayer}
        onStartEraser={editor.startEraser}
        onApplyEraser={editor.applyEraser}
      />

      <LayerList
        layers={editor.layers}
        selectedLayerId={editor.selectedLayerId}
        onSelectLayer={editor.setSelectedLayerId}
        onRemoveLayer={editor.removeLayer}
        onReorderLayer={editor.reorderLayer}
      />

      <div className="scroll-y" style={{ maxHeight: 280 }}>
        {editor.activeTab === 'size' && (
          <SizeTool
            selectedPreset={editor.selectedPreset}
            onPresetChange={editor.setSelectedPreset}
          />
        )}
        {editor.activeTab === 'background' && (
          <BackgroundRemoval
            status={editor.bgRemovalStatus}
            hasSelectedLayer={editor.selectedLayer !== null}
            onRemove={editor.removeBackground}
            onRemoveColor={editor.removeColorBg}
            onRestore={editor.restoreOriginal}
          />
        )}
        {editor.activeTab === 'eraser' && (
          <EraserTool
            hasSelectedLayer={editor.selectedLayer !== null}
            eraserSize={editor.eraserSize}
            onSizeChange={editor.setEraserSize}
            onRestore={editor.restoreOriginal}
          />
        )}
        {editor.activeTab === 'color-change' && (
          <ColorChange
            isActive={editor.selectedLayer?.bgRemoved ?? false}
            currentColor={editor.selectedLayer?.colorTint ?? null}
            onChangeColor={editor.changeColor}
          />
        )}
        {editor.activeTab === 'correction' && (
          <ColorCorrection
            layer={editor.selectedLayer}
            onUpdate={editor.updateCorrection}
            onReset={editor.resetCorrection}
          />
        )}
      </div>

      <TabBar
        activeTab={editor.activeTab}
        onTabChange={editor.setActiveTab}
      />
    </div>
  );
}
