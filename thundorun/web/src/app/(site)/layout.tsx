import SiteHeader from '@/components/SiteHeader';
import SiteFooter from '@/components/SiteFooter';
import SiteProviders from './Providers';
import TrafficBeacon from '@/components/TrafficBeacon';

export default function SiteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SiteProviders>
      <a className="skip-link" href="#main">본문으로 건너뛰기</a>
      {/* 헤더 sticky + 짧은 페이지에서도 푸터가 하단에 붙도록 최소 높이만 지정한다(치수 전용 인라인 스타일). */}
      <div style={{ display: 'flex', minHeight: '100dvh', flexDirection: 'column' }}>
        <SiteHeader />
        <main id="main" style={{ flex: 1 }}>{children}</main>
        <SiteFooter />
      </div>
      <TrafficBeacon />
    </SiteProviders>
  );
}
