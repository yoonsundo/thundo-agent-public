'use client';

import { Maximize2, ImageIcon, Eraser, Palette, SlidersHorizontal } from 'lucide-react';
import { EditorTab } from '@/types/editor';

interface TabBarProps {
  activeTab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
}

const tabs: { id: EditorTab; label: string; icon: typeof Maximize2 }[] = [
  { id: 'size',          label: '사이즈', icon: Maximize2 },
  { id: 'background',    label: '배경',   icon: ImageIcon },
  { id: 'eraser',        label: '지우개', icon: Eraser },
  { id: 'color-change',  label: '색상',   icon: Palette },
  { id: 'correction',    label: '보정',   icon: SlidersHorizontal },
];

export default function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="tabs" role="tablist" aria-label="편집 도구">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={activeTab === id}
          onClick={() => onTabChange(id)}
          className="tab"
        >
          <Icon size={20} aria-hidden />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
