import { Suspense } from 'react';
import LoginForm from './LoginForm';

export const metadata = {
  title: '로그인 — Thundo',
};

export default function LoginPage() {
  return (
    <div className="container-narrow row" style={{ minHeight: '60vh', justifyContent: 'center' }}>
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        <div className="stack-2" style={{ marginBottom: 'var(--space-6)' }}>
          <h1 className="page-title">로그인</h1>
          <p className="text-muted">Thundo 계정으로 로그인하세요</p>
        </div>
        {/* useSearchParams needs Suspense boundary */}
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
