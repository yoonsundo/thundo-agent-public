'use client';

/**
 * TrafficCharts — 트래픽 대시보드용 순수 SVG 차트 (외부 차트 라이브러리 0). DESIGN.md §11.6.
 *
 * 색은 키트 토큰만 쓴다 — 선·영역·주 계열은 `--color-accent`, 보조 계열은 `--color-info`,
 * 그리드·트랙은 `--color-hairline`, 글자는 `--color-text`. 배경 그라디언트는 규칙 5 위반이라
 * 단색 + opacity 로 표현한다.
 *   - AreaChartPV: 일자별 PV 추세(부드러운 곡선 + 단색 영역 + 그리드 + 마지막점 강조)
 *   - DonutUV: client vs server UV 비율 링(중앙 총합 + `.legend` 범례)
 *   - BarList: 가로 막대 순위(키트 `.progress` 재사용)
 */

// ── 부드러운 곡선 path (Catmull-Rom → cubic bezier) ───────────────────────────
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  const d: string[] = [`M ${pts[0][0]},${pts[0][1]}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d.push(`C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`);
  }
  return d.join(' ');
}

interface DayPoint { date: string; pv: number }

export function AreaChartPV({ data, height = 160 }: { data: DayPoint[]; height?: number }) {
  if (!data || data.length === 0) {
    return <EmptyChart height={height} label="추세 데이터 없음" />;
  }
  const W = 600;
  const padX = 8;
  const padTop = 16;
  const padBottom = 22;
  const innerH = height - padTop - padBottom;
  const max = Math.max(...data.map((d) => d.pv), 1);
  const n = data.length;
  const step = n > 1 ? (W - padX * 2) / (n - 1) : 0;
  const xy = data.map((d, i) => [padX + i * step, padTop + innerH - (d.pv / max) * innerH] as [number, number]);
  const line = smoothPath(xy);
  const area = `${line} L ${xy[n - 1][0].toFixed(2)},${padTop + innerH} L ${xy[0][0].toFixed(2)},${padTop + innerH} Z`;
  const last = xy[n - 1];
  const peakIdx = data.reduce((bi, d, i) => (d.pv > data[bi].pv ? i : bi), 0);

  // y 그리드 3줄(상단 경계선 제외)
  const grid = [0.25, 0.5, 0.75].map((f) => padTop + innerH - innerH * f);
  const fmtDate = (s: string) => s.slice(5); // MM-DD

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="일자별 조회수 추세">
      {grid.map((gy, i) => (
        <line key={i} x1={padX} y1={gy} x2={W - padX} y2={gy} stroke="var(--color-hairline)" strokeWidth="1" strokeDasharray="2 4" />
      ))}
      <path d={area} fill="var(--color-accent)" fillOpacity="0.12" />
      <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {/* 피크 마커 */}
      <circle cx={xy[peakIdx][0]} cy={xy[peakIdx][1]} r="3" fill="var(--color-bg)" stroke="var(--color-accent)" strokeWidth="2" />
      {/* 마지막 값 강조 */}
      <circle cx={last[0]} cy={last[1]} r="7" fill="var(--color-accent)" fillOpacity="0.18" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--color-accent)" stroke="var(--color-bg)" strokeWidth="1.5" />
      {/* x축 날짜(처음/중간/끝) */}
      {[0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((idx) => (
        <text
          key={idx}
          x={Math.min(Math.max(xy[idx][0], 14), W - 14)}
          y={height - 6}
          fontSize="11"
          fill="var(--color-text)"
          fillOpacity="0.55"
          textAnchor="middle"
        >
          {fmtDate(data[idx].date)}
        </text>
      ))}
    </svg>
  );
}

interface DonutSeg { label: string; value: number; tone?: 'info' }

export function DonutUV({ clientUV, serverUV, size = 132 }: { clientUV: number; serverUV: number; size?: number }) {
  const segs: DonutSeg[] = [
    { label: '실측(브라우저)', value: clientUV },
    { label: '서버추정',       value: serverUV, tone: 'info' },
  ];
  const total = clientUV + serverUV;
  const r = size / 2 - 12;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="row">
      <svg
        className="chart"
        viewBox={`0 0 ${size} ${size}`}
        style={{ width: size, height: size, flex: 'none' }}
        role="img"
        aria-label="UV 구성"
      >
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-hairline)" strokeWidth="12" />
        {total > 0 && segs.map((s, i) => {
          const frac = s.value / total;
          const dash = frac * circ;
          const el = (
            <circle
              key={i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={s.tone === 'info' ? 'var(--color-info)' : 'var(--color-accent)'}
              strokeWidth="12" strokeLinecap="round"
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          offset += dash;
          return el;
        })}
        <text x={cx} y={cy - 2} fontSize="24" fontWeight="800" fill="var(--color-text)" textAnchor="middle">
          {clientUV.toLocaleString()}
        </text>
        <text x={cx} y={cy + 16} fontSize="11" fill="var(--color-text)" fillOpacity="0.55" textAnchor="middle">
          방문자(실측)
        </text>
      </svg>
      <div className="legend">
        {segs.map((s) => (
          <div className="legend-row" key={s.label}>
            <span className="legend-mark" data-tone={s.tone} />
            <span>{s.label}</span>
            <span className="legend-value">{s.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BarItem { label: string; value: number }

export function BarList({
  items,
  tone,
  empty = '데이터 없음',
  max = 8,
}: {
  items: BarItem[];
  /** 막대 색 계열 — 기본은 강조색, 'success' 는 키트 `.progress[data-tone]`. */
  tone?: 'success';
  empty?: string;
  max?: number;
}) {
  if (!items || items.length === 0) {
    return <p className="text-muted">{empty}</p>;
  }
  const top = items.slice(0, max);
  const peak = Math.max(...top.map((i) => i.value), 1);
  return (
    <div className="stack-2">
      {top.map((it, i) => {
        const w = Math.max((it.value / peak) * 100, 2);
        return (
          <div className="stack-2" key={`${it.label}-${i}`}>
            <div className="legend-row">
              {/* 경로·리퍼러는 공백 없는 긴 문자열이라 끊어 감싸야 셀을 넘지 않는다. */}
              <span className="text-mono" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{it.label}</span>
              <span className="legend-value">{it.value.toLocaleString()}</span>
            </div>
            <div className="progress" data-tone={tone}>
              <span style={{ width: `${w}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyChart({ height, label }: { height: number; label: string }) {
  return (
    <div className="chart-empty" style={{ height }}>
      {label}
    </div>
  );
}
