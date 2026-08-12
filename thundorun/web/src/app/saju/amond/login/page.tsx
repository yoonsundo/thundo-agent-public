'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
    } else {
      router.push('/saju/amond');
    }
  }

  return (
    <div
      className="page-narrow"
      style={{ display: 'flex', minHeight: '70vh', alignItems: 'center', justifyContent: 'center' }}
    >
      <div className="card stack" style={{ width: '100%', maxWidth: 360 }}>
        <h2>관리자 로그인</h2>

        <form onSubmit={handleSubmit} className="stack">
          <div className="field">
            <label htmlFor="admin-email">아이디<span className="req">*</span></label>
            <input
              id="admin-email"
              className="input"
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </div>

          <div className="field" data-invalid={!!error}>
            <label htmlFor="admin-pw">비밀번호<span className="req">*</span></label>
            <input
              id="admin-pw"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
            {error && <span className="field-error">{error}</span>}
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading && <span className="spinner" />}
            {loading ? '로그인 중…' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}
