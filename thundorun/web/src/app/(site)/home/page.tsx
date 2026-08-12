import Link from 'next/link';
import { ImageIcon, Moon, Spade, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const metadata = {
  title: 'Home — Thundo 도구함',
  description: '사진 편집 · 사주 · 꿈해몽 · 타로 도구를 선택하세요.',
};

interface Tool {
  href: string;
  /** lucide-react 아이콘. 이모지 금지(DESIGN.md 규칙 8). */
  icon: LucideIcon;
  title: string;
  desc: string;
}

const tools: Tool[] = [
  { href: '/run',   icon: ImageIcon, title: 'TH-BOX',        desc: '사진 편집기' },
  { href: '/saju',  icon: Sparkles,  title: 'THUNDO 사주',   desc: '만세력 사주 풀이' },
  { href: '/dream', icon: Moon,      title: 'THUNDO 꿈해몽', desc: '꿈 풀이 · 길흉 · 행운 번호' },
  { href: '/tarot', icon: Spade,     title: 'THUNDO 타로',   desc: '카드 세 장으로 보는 오늘' },
];

export default function HubPage() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-8)' }}>
      <div className="page-head">
        <div>
          <p className="kicker">도구함</p>
          <h1 className="page-title">THUNDO</h1>
          <p className="page-sub">서비스를 선택하세요</p>
        </div>
      </div>

      <div className="grid-2">
        {tools.map(({ href, icon: Icon, title, desc }) => (
          <Link key={href} href={href} className="card card-link">
            <div className="row">
              <Icon size={20} aria-hidden />
              <span className="card-title">{title}</span>
            </div>
            <p className="card-body">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
