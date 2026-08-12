import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'THUNDO 꿈해몽',
  description: '꿈의 의미를 풀어드리는 꿈해몽 서비스',
};

export default function DreamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="page-narrow">
      <header className="site-header pt-safe">
        <div className="container-narrow site-header-inner">
          <Link href="/" className="nav-item" aria-label="메인으로 돌아가기">
            <ArrowLeft size={16} aria-hidden />
            메인
          </Link>
          <span className="nav-divider" />
          <Link href="/dream" className="site-brand">
            THUNDO 꿈해몽
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
