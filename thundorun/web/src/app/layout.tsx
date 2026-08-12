import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/react';
import { GoogleAnalytics } from '@next/third-parties/google';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.thundo.kr'),
  title: {
    default: 'Thundo',
    template: '%s — Thundo',
  },
  description: 'AI 도구 · 자동화 · 생산성',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Thundo',
  },
  openGraph: {
    siteName: 'Thundo',
    locale: 'ko_KR',
    type: 'website',
  },
  verification: {
    google: 'rXZpTz_o0N9MpV4i7GIbhbFzTzldGlsnfLw-YrTNrJk',
    other: { 'naver-site-verification': '64718046ef15ff311b666dd139e0903d8ee78152' },
  },
};

const BASE = 'https://www.thundo.kr';

// 사이트 전역 구조화데이터: Organization + WebSite (브랜드·사이트 인식 신호).
// 사이트 내 검색 기능이 없으므로 SearchAction 은 넣지 않는다(허위 신호 금지).
const siteJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id':   `${BASE}/#organization`,
      name:    'Thundo',
      url:     BASE,
      logo:    `${BASE}/icons/icon-512.png`,
    },
    {
      '@type':    'WebSite',
      '@id':      `${BASE}/#website`,
      name:       'Thundo',
      url:        BASE,
      inLanguage: 'ko',
      publisher:  { '@id': `${BASE}/#organization` },
    },
  ],
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // 키트 정본 기본값 = light. 저장된 선택은 아래 인라인 스크립트가 페인트 전에 복원한다.
    <html lang="ko" data-theme="light">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd).replace(/</g, '\\u003c') }}
        />
      </head>
      <body>
        {children}
        <Analytics />
      </body>
      {/* Google Analytics — NEXT_PUBLIC_GA_ID(G-XXXX)가 설정된 경우에만 로드.
          Vercel 환경변수에 ID를 넣으면 자동 활성화(페이지 이동 추적 포함). */}
      {process.env.NEXT_PUBLIC_GA_ID && (
        <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_ID} />
      )}
    </html>
  );
}
