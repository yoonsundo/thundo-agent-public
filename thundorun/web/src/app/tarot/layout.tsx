import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'THUNDO 타로',
  description: '타로 카드로 보는 운세 풀이 서비스',
};

export default function TarotLayout({
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
          <Link href="/tarot" className="site-brand">
            THUNDO 타로
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
