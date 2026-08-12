import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export default function SajuNav() {
  return (
    <header className="site-header pt-safe">
      <div className="container-narrow site-header-inner">
        <Link href="/" className="nav-item" aria-label="메인으로 돌아가기">
          <ArrowLeft size={16} aria-hidden />
          메인
        </Link>
        <span className="nav-divider" />
        <Link href="/saju" className="site-brand">
          THUNDO 사주
        </Link>
      </div>
    </header>
  );
}
