'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') ?? '/';

  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await signIn('credentials', {
      // email 필드명은 CredentialsProvider 정의와 일치 (하위 호환)
      email: id.trim(),
      password,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
    } else {
      router.push(callbackUrl);
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} className="stack">
      {error && (
        <div className="banner" data-tone="danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="field">
        <label htmlFor="login-id">아이디</label>
        <input
          id="login-id"
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
          autoComplete="username"
          placeholder="아이디를 입력하세요"
          className="input"
        />
      </div>

      <div className="field">
        <label htmlFor="login-pw">비밀번호</label>
        <input
          id="login-pw"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          placeholder="비밀번호를 입력하세요"
          className="input"
        />
      </div>

      <button type="submit" disabled={loading} className="btn btn-primary btn-block">
        {loading && <span className="spinner" />}
        {loading ? '로그인 중…' : '로그인'}
      </button>
    </form>
  );
}
