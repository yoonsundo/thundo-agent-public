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

      {/* 도구 패널 높이는 **탭과 무관하게 일정**해야 한다.
          `maxHeight` 였을 때는 탭마다 내용 높이가 달라 패널이 늘었다 줄었다 했고,
          그만큼 위쪽 작업공간(flex:1)이 변해 **크롭 프레임 크기가 같이 바뀌었다**
          (사이즈→스토리 지정 후 배경제거로 들어가면 테두리가 달라지던 증상, 2026-08-20 지적).
          프레임은 작업공간의 `calc(100% - 80px)` 이라 작업공간이 흔들리면 그대로 따라 흔들린다.

          ⚠ 그렇다고 280px 로 못 박으면 폰에서 편집을 못 한다. `100dvh` 는 아이폰 13 에서도
             실측 **664px** 뿐이고(사파리 크롬 제외), 헤더·썸네일·탭까지 빼면 작업공간이
             200px 아래로 떨어져 프레임이 100px 대가 된다.
          → 화면 높이에 비례하되 **내용이 아니라 뷰포트에만** 의존하게 한다. 뷰포트는 탭 전환으로
             바뀌지 않으므로 프레임은 그대로 유지되고, 작은 화면에서는 패널이 알아서 작아진다. */}
      <div className="scroll-y" style={{ height: 'clamp(150px, 28vh, 280px)', flex: 'none' }}>
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
