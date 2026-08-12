'use client';

/**
 * TrafficBeacon — UV(순방문자) 클라이언트 비콘.
 * 경로 변화마다 navigator.sendBeacon('/api/pv') 로 cid(쿠키리스 localStorage 식별자)를 전송.
 * 역할 분담: PV(조회수)는 서버 미들웨어가 집계, 이 컴포넌트는 UV(client) 신호만 담당.
 * 광고차단/JS꺼짐이면 누락되므로 "사람 UV 하한값"으로만 해석(서버 HMAC UV 와 병기).
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

const CID_KEY = 'tr_cid';

function getCid(): string {
  try {
    let cid = localStorage.getItem(CID_KEY);
    if (!cid) {
      cid = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(CID_KEY, cid);
    }
    return cid;
  } catch {
    return 'anon';
  }
}

export default function TrafficBeacon() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    // 비공개/내부 경로는 비콘 생략(서버 allowlist 와 정합).
    if (!(pathname === '/' || pathname.startsWith('/blog') || pathname.startsWith('/reports'))) return;
    try {
      const cid = getCid();
      const ref = document.referrer || '';
      const payload = JSON.stringify({ cid, path: pathname, ref });
      const blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/pv', blob);
      } else {
        fetch('/api/pv', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
      }
    } catch {
      /* best-effort: 비콘 실패는 무시 */
    }
  }, [pathname]);

  return null;
}
