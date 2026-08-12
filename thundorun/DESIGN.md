# DESIGN.md — 공통 UI 컨벤션 (Modernist Kit)

> **AI 코딩 에이전트 지침**: 이 프로젝트의 모든 화면은 `globals.css`에 정의된
> 토큰과 클래스만으로 만든다. 아래 규칙을 어기는 코드는 리뷰에서 반려한다.

## Source of truth
- Status: Active
- Last refreshed: 2026-08-05
- Primary product surfaces: 공개 사이트, 관리자 화면, 포트폴리오 미리보기, 이미지 편집기
- Evidence reviewed: `web/src/app/globals.css`, 기존 `.tabs`·`.accordion`·`.grid-2`, 포트폴리오 화면과 디자인 가드

## Brand
- Personality: 절제된 모더니스트, 기술적 신뢰, 한국어 가독성
- Trust signals: 일관된 토큰, 명확한 정보 계층, 실제 운영·검증 근거
- Avoid: 장식성 배너 남용, 즉흥 색·간격, 과도한 강조

## Product goals
- Goals: 콘텐츠와 프로젝트 정보를 빠르게 탐색하고 판단할 수 있게 한다.
- Non-goals: 페이지별 독자 디자인 시스템이나 신규 UI 라이브러리를 만들지 않는다.
- Success signals: 핵심 경로가 키보드·모바일에서도 이해되고 디자인·브라우저 가드를 통과한다.

## Personas and jobs
- Primary personas: 사이트 방문자, 채용 현업 담당자, 운영 관리자
- User jobs: 콘텐츠 탐색, 프로젝트 역량 검토, 발행·운영 상태 확인
- Key contexts of use: 데스크톱 관리자 화면과 좁은 모바일 공개 화면

## Information architecture
- Primary navigation: 공개 사이트 헤더와 관리자 사이드바
- Core routes/screens: 홈, 블로그, 영상, 리포트, 관리자 대시보드, 포트폴리오 미리보기
- Content hierarchy: 페이지 제목 → 탭/필터 → 요약 카드 → 펼침 상세

## Design principles
- 기존 Modernist Kit 컴포넌트와 토큰을 우선 재사용한다.
- 정보 경계는 중복 설명 배너보다 탭·제목·구분선으로 표현한다.
- 카드 목록은 접힌 상태의 높이를 통일하고 상세를 펼치면 콘텐츠 길이에 맞춰 확장한다.

## Visual language
- Color: 중성 표면과 제한된 빨강 강조색
- Typography: Archivo와 Pretendard 기반 왼쪽 정렬 계층
- Spacing/layout rhythm: `--space-*`, 반응형 그리드
- Shape/radius/elevation: 토큰 반경, 정적 카드 그림자 금지
- Motion: 짧고 기능적인 상태 전환만 사용
- Imagery/iconography: 콘텐츠 이미지는 원색, 아이콘은 Lucide만 사용

## Components
- Existing components to reuse: `.tabs`, `.tab`, `.grid-2`, `.accordion`, 상태 컴포넌트
- New/changed components: 포트폴리오 분류 탭과 `.portfolio-card`, 에이전트 소개의 팀별 2열 파이프라인 아코디언
- Variants and states: 활성 탭, 빈 분류, 접힘/펼침 카드
- Token/component ownership: 전역 토큰과 확장 클래스는 `globals.css`와 이 문서가 공동 소유한다.

## Accessibility
- Target standard: 의미 있는 HTML과 WCAG 수준의 키보드·스크린리더 지원
- Keyboard/focus behavior: 포커스 링 유지, 탭은 `role=tab`·`aria-selected`·`aria-controls` 제공
- Contrast/readability: 토큰 대비와 한국어 어절 가독성을 유지한다.
- Screen-reader semantics: 탭과 패널을 명시적으로 연결한다.
- Reduced motion and sensory considerations: 핵심 정보는 움직임이나 색만으로 전달하지 않는다.

## Responsive behavior
- Supported breakpoints/devices: 390px, 768px, 1280px 감사 뷰포트
- Layout adaptations: 900px 이하에서 2열 그리드를 1열로 전환한다. 에이전트 파이프라인은 팀 단위 native details를 기본 접힘으로 두어 모바일에서 필요한 흐름만 펼친다.
- Touch/hover differences: 터치 타깃 최소 크기와 가로 스크롤 탭을 유지한다.

## Interaction states
- Loading: 완성 화면과 같은 스켈레톤
- Empty: 원인과 다음 행동이 있는 빈 상태
- Error: 원인과 재시도 수단이 있는 위험 배너
- Success: 필요한 경우에만 토스트로 결과를 알린다.
- Disabled: 비활성 이유를 문맥으로 이해할 수 있게 한다.
- Offline/slow network: 서버 화면은 로딩·오류 경계를 유지한다.

## Content voice
- Tone: 짧고 구체적인 한국어, 기술 용어는 판단에 필요한 만큼만 사용
- Terminology: 같은 개념은 메뉴·제목·탭에서 같은 이름으로 표기
- Microcopy rules: 설명을 중복하는 상주 배너를 만들지 않는다.

## Implementation constraints
- Framework/styling system: Next.js, React, 단일 `globals.css` Modernist Kit
- Design-token constraints: 색·간격·반경·그림자는 토큰만 사용
- Performance constraints: 신규 UI 의존성을 추가하지 않는다.
- Compatibility constraints: 보호 라우트와 서버 렌더링 경계를 유지한다.
- Test/screenshot expectations: `test:design`, 전체 테스트, 타입 검사, 빌드, 필요 시 실브라우저 감사

## Open questions
- [ ] 현재 없음. 새 시각 기준이나 공개 포트폴리오 요구가 생기면 이 절에 기록한다.

---

## 0. 설치

```
app/
  globals.css      ← kit/globals.css 를 그대로 복사
  layout.tsx       ← import "./globals.css"
```

```tsx
// app/layout.tsx
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
```

CSS-in-JS, Tailwind, MUI, styled-components **모두 사용하지 않는다.**
UI 라이브러리를 추가로 설치하지 않는다.

---

## 1. 절대 규칙 (Hard rules)

| # | 규칙 |
|---|------|
| 1 | **하드코딩 금지.** 색·폰트·간격·그림자는 반드시 `var(--*)`. `#fff`, `16px`, `Inter` 직접 입력 금지 |
| 2 | **모서리 반경은 토큰으로.** `border-radius`는 `var(--radius-sm/md/lg/pill)`(4/8/12/999)만 사용. 임의 px 금지 |
| 3 | **왼쪽 정렬.** 제목·본문·넓은 버튼의 라벨은 flush left. 히어로 카피 가운데 정렬 금지 |
| 4 | **구분선은 2px.** 섹션 사이는 `.hr` 또는 `border-bottom: 2px solid var(--color-divider)`. 헤어라인으로 약화시키지 말 것 |
| 5 | **강조색은 아껴서.** 빨강(`--color-accent`)은 주요 액션 1개 + 작은 강조에만. 배경 그라디언트 금지 |
| 6 | ~~**사진은 흑백.**~~ → **이 저장소에서는 적용하지 않는다. §12.11 참조** |
| 7 | **새 클래스보다 기존 클래스.** 없으면 `globals.css`에 추가하고 이 문서에 등재 |
| 8 | **이모지 금지.** 아이콘은 [Lucide](https://lucide.dev) (`lucide-react`)만 사용, 크기 16/18/20px |

## 2. 간격 · 타이포

- 간격은 `--space-1..12` (4/8/12/16/24/32/48). 그 사이 값 사용 금지.
- 모서리는 `--radius-sm`(4, 작은 요소) / `--radius-md`(8, 버튼·입력·배너) / `--radius-lg`(12, 카드·다이얼로그) / `--radius-pill`(태그·배지·아바타·스위치).
- 폰트는 Archivo 한 종류. 제목은 800, 본문 400, 강조 600.
- 크기: h1 42 / h2 32 / h3 25 / h4 20 / h5 16 / h6 13(대문자 트래킹) / 본문 15 / 보조 13 / 캡션 11.
- 본문 텍스트에 강조색을 쓸 땐 `--color-accent-700` (대비 확보).

## 3. 색 역할

| 토큰 | 용도 |
|---|---|
| `--color-bg` | 페이지 바닥 |
| `--color-surface` | 카드·사이드바·입력 필드 배경 |
| `--color-accent` | 주 액션, 활성 탭/메뉴, 링크 |
| `--color-divider` | 2px 강한 구분선 |
| `--color-hairline` | 표 행 사이 1px |
| `--color-success / warning / danger / info` | **상태 표현 전용**. 브랜드 용도 금지 |

램프(`--color-accent-100..900`)는 hover/pressed/틴트에 사용. `color-mix()` 즉흥 조합보다 램프 우선.

## 4. 컴포넌트 카탈로그

> 아래 마크업이 **정본**이다. 그대로 복사해 쓰고, 여기에 없는 스타일은 만들지 않는다.
> 요약: 셸 · 페이지 · 레이아웃 · 타이포 · 버튼 · 태그 · 폼 · 테이블 · 목록 · 카드 · 내비 · 타임라인 · 아바타 · 피드백 · 상태.

### 4.1 앱 셸

`.shell` `.sidebar` `.sidebar-brand` `.sidebar-mark` `.sidebar-group` `.nav-item` `.topbar` `.crumb` `.avatar`

```tsx
<div className="shell" data-collapsed={collapsed}>
  <aside className="sidebar">
    <div className="sidebar-brand"><span className="sidebar-mark" />ORBIT</div>
    <div className="sidebar-group kicker">업무</div>
    <a className="nav-item" aria-current="page" href="/dashboard">대시보드<span className="badge nav-badge">3</span></a>
    <a className="nav-item" href="/orders">주문 목록</a>
    <div className="spacer" />
  </aside>
  <div className="shell-main">
    <header className="topbar">
      <button className="btn btn-icon" aria-label="사이드바 접기">≡</button>
      <div className="crumb"><span>ORBIT</span><span>/</span><b>주문 목록</b></div>
      <div className="spacer" />
      <input className="input" style={{ width: 240 }} placeholder="전체 검색" />
      <div className="avatar">KJ</div>
    </header>
    <div className="shell-body">{children}</div>
  </div>
</div>
```

`data-collapsed="true"` → 사이드바 60px. 활성 메뉴는 반드시 `aria-current="page"`.

### 4.2 페이지 · 레이아웃

`.page` `.page-head` `.page-title` `.page-sub` `.page-actions` `.section-head`
`.stack`(12) `.stack-2`(8) `.stack-6`(24) `.row` `.row-end` `.spacer`
`.grid-2` `.grid-3` `.grid-4` `.grid-sidebar`(2:1) — 900px 이하에서 1열로 자동 붕괴

```tsx
<div className="page">
  <div className="page-head">
    <div><h1 className="page-title">주문 목록</h1><p className="page-sub">전체 1,284건</p></div>
    <div className="page-actions"><button className="btn btn-secondary">내보내기</button><button className="btn btn-primary">등록</button></div>
  </div>
  <div className="section-head"><h4>최근 주문</h4><span className="text-muted">단위: 건</span></div>
</div>
```

### 4.3 타이포

`h1`~`h6` (42/32/25/20/16/13) · `.kicker` · `.text-muted` · `.text-mono` · `.text-ellipsis` · `.code` · `.kbd` · `.hr`(1px) `.hr-thin`

`.text-ellipsis` 는 긴 값(브랜치명·경로)을 한 줄 말줄임으로 자른다. flex 자식에 쓸 땐 **감싼 상자의 자동 최소크기도 함께 풀어야** 한다 — 부모의 min-content 는 여전히 자식 nowrap 텍스트의 전체 폭이라, 안 풀면 말줄임이 발동조차 하지 않는다(2026-07-31 실측).

```tsx
<p className="kicker">SECTION</p>
<p className="text-muted">보조 설명 13px</p>
<span className="code">--color-accent</span>
<span className="kbd">⌘</span> <span className="kbd">K</span>
<hr className="hr" />
```

### 4.4 버튼

`.btn` + `.btn-primary` `.btn-secondary` `.btn-ghost` `.btn-danger` `.btn-icon` `.btn-sm` `.btn-block` `.btn-row` `.btn-pill`

```tsx
<button className="btn btn-primary">주 액션</button>
<button className="btn btn-secondary">보조</button>
<button className="btn btn-ghost">고스트</button>
<button className="btn btn-danger">삭제</button>
<button className="btn btn-secondary btn-sm">작게</button>
<button className="btn btn-icon" aria-label="더보기">⋯</button>
<button className="btn btn-primary" disabled><span className="spinner" />저장 중…</button>
```

한 화면에 `.btn-primary`는 **하나**. `.btn-block`은 라벨이 왼쪽 정렬된다.

`.btn-row` 는 `.btn-block` 위에 얹는 변형으로, **카드 한 줄을 통째로 감싸는 버튼**(이름·설명·배지가 함께 들어가는 파이프라인 행 등)에만 쓴다. `.btn` 의 nowrap 은 짧은 라벨 전제라 그런 버튼에선 내용이 접히지 못해 화면 밖으로 나간다. `.btn-block` 전체를 푸는 건 금물 — 아이콘+라벨 버튼이 아이콘과 글자로 쪼개진다.

### 4.5 태그 · 배지 · 칩

`.tag` + `-accent` `-neutral` `-outline` `-success` `-warning` `-danger` `-info` · `.badge` · `.chip`

```tsx
<span className="tag tag-success">완료</span>
<span className="tag tag-info">처리중</span>
<span className="tag tag-warning">대기</span>
<span className="tag tag-danger">취소</span>
<span className="badge">7</span>
<span className="chip">상태: 완료<button aria-label="필터 제거">✕</button></span>
```

상태 색 매핑은 프로젝트 전체에서 하나로 고정한다: 완료=success, 처리중=info, 대기=warning, 취소=danger.

### 4.6 폼

`.field` `.input` `select.input` `textarea.input` `.field-hint` `.field-error` `.field[data-invalid]` `.radio`+`.dot` `.check`+`.box` `.switch`+`.track` `.seg`+`.seg-opt`

```tsx
<div className="grid-2">
  <div className="field" data-invalid={!!err}>
    <label htmlFor="customer">거래처명<span className="req">*</span></label>
    <input id="customer" className="input" placeholder="(주)오르빗커머스" />
    {err ? <span className="field-error">거래처명은 필수입니다.</span>
         : <span className="field-hint">사업자등록증상 상호를 입력하세요.</span>}
  </div>
  <div className="field"><label>상태</label>
    <select className="input"><option>전체</option></select>
  </div>
</div>

<label className="radio"><input type="radio" name="ship" /><span className="dot" />일반 택배</label>
<label className="check"><input type="checkbox" /><span className="box">✓</span>동의합니다</label>
<label className="switch"><input type="checkbox" /><span className="track" />이메일 알림</label>

<div className="seg">
  <label className="seg-opt"><input type="radio" name="range" defaultChecked />7일</label>
  <label className="seg-opt"><input type="radio" name="range" />30일</label>
</div>
```

### 4.7 테이블 · 툴바 · 페이지네이션

`.toolbar` `.table` `.table th[aria-sort]` `.table .num` `.table tr[data-selected]` `.pagination` `.page-btn`

```tsx
<div className="toolbar">
  <input className="input" style={{ width: 280 }} placeholder="주문번호 · 거래처 검색" />
  <select className="input" style={{ width: 150 }}><option>전체 상태</option></select>
  <div className="spacer" />
  <button className="btn btn-danger btn-sm" disabled={!sel.length}>선택 삭제</button>
</div>

<table className="table">
  <thead><tr>
    <th style={{ width: 36 }}><label className="check"><input type="checkbox" /><span className="box">✓</span></label></th>
    <th aria-sort="descending" onClick={sortBy("id")}>주문번호</th>
    <th>거래처</th><th>상태</th><th className="num">금액</th><th />
  </tr></thead>
  <tbody>
    {rows.map(r => (
      <tr key={r.id} data-selected={sel.includes(r.id)}>
        <td><label className="check"><input type="checkbox" /><span className="box">✓</span></label></td>
        <td className="text-mono">{r.id}</td>
        <td>{r.customer}</td>
        <td><span className={`tag ${TONE[r.status]}`}>{r.status}</span></td>
        <td className="num">{won(r.value)}</td>
        <td className="num"><button className="btn btn-ghost btn-sm">상세</button></td>
      </tr>
    ))}
  </tbody>
</table>

<div className="pagination">
  <button className="page-btn" disabled>◀ 이전</button>
  <button className="page-btn" aria-current="page">1</button>
  <button className="page-btn">2</button>
  <button className="page-btn">다음 ▶</button>
  <div className="spacer" /><span className="text-muted">1–8 / 14건</span>
</div>
```

금액·수량 열은 `.num`(우측 정렬 + tabular-nums), 식별자는 `.text-mono`. 정렬 가능한 헤더는 `aria-sort` 필수.

### 4.8 목록 · 정의 목록

`.list` `.list-row` · `.dl` (`dt` 140px 고정 + `dd`)

```tsx
<div className="list">
  <div className="list-row">
    <div className="avatar">KJ</div>
    <div style={{ flex: 1 }}><div>김지현</div><div className="card-meta">영업1팀</div></div>
    <span className="tag tag-success">활성</span>
  </div>
</div>

<dl className="dl">
  <dt>주문번호</dt><dd className="text-mono">ORD-24710</dd>
  <dt>상태</dt><dd><span className="tag tag-success">완료</span></dd>
</dl>
```

### 4.9 카드 · 지표 · 진행률

`.card` `.card-outline` `.card-kicker` `.card-title` `.card-body` `.card-meta` `.elev-sm|md|lg`
`.stat` `.stat-label` `.stat-value` `.stat-delta[data-dir=up|down]` · `.progress`

```tsx
<div className="stat">
  <span className="stat-label">신규 주문</span>
  <span className="stat-value">1,284</span>
  <span className="stat-delta" data-dir="up">▲ 12.4% 전주 대비</span>
</div>

<div className="card">
  <span className="card-kicker">할 일</span>
  <span className="card-title">승인 대기 8건</span>
  <p className="card-body">3일 이상 지연된 주문이 포함되어 있습니다.</p>
  <div className="card-meta">2026-07-30</div>
</div>

<div className="progress"><span style={{ width: "86%" }} /></div>
<div className="progress" data-tone="success"><span style={{ width: "100%" }} /></div>
```

`.elev-*`는 실제로 떠 있는 요소(팝오버·드래그 중)에만. 정적 카드에 그림자 금지.

### 4.10 내비게이션

`.tabs` `.tab[aria-selected]` · `.crumb` · `.stepper`

```tsx
<div className="tabs" role="tablist">
  <button className="tab" role="tab" aria-selected={tab === 0}>개요</button>
  <button className="tab" role="tab" aria-selected={tab === 1}>품목 4</button>
</div>

<ol className="stepper">
  <li data-state="done">주문 접수</li>
  <li aria-current="step">승인 대기</li>
  <li>출고</li>
</ol>
```

### 4.11 타임라인 · 아코디언 · 툴팁

`.timeline` · `.accordion`(native `<details>`) · `.tooltip[data-tip]`

```tsx
<ul className="timeline">
  <li><div><div>결제 확인 완료</div><div className="card-meta">2026-07-28 14:02</div></div></li>
</ul>

<details className="accordion" open>
  <summary>배송 정책은 어떻게 되나요?</summary>
  <div className="accordion-body">오후 2시 이전 주문은 당일 출고됩니다.</div>
</details>

<button className="btn btn-icon tooltip" data-tip="설명 문구" aria-label="도움말">?</button>
```

### 4.12 아바타

`.avatar` `.avatar-neutral` `.avatar-group`

```tsx
<div className="avatar">KJ</div>
<div className="avatar-group">
  <span className="avatar">KJ</span><span className="avatar avatar-neutral">PD</span>
  <span className="avatar avatar-neutral">+5</span>
</div>
```

### 4.13 피드백 — 배너 · 다이얼로그 · 드로어 · 토스트

`.banner[data-tone=info|success|warning|danger]` · `.dialog-backdrop`+`.dialog` · `.drawer-backdrop`+`.drawer` · `.toast-stack`+`.toast`

```tsx
<div className="banner" data-tone="warning"><span><b>정산 마감 D-2</b><br />지연 주문 27건을 확인해 주세요.</span></div>

<div className="dialog-backdrop" onClick={close}>
  <div className="dialog" role="dialog" aria-modal="true" onClick={stop}>
    <span className="dialog-title">주문을 취소할까요?</span>
    <p className="dialog-body">취소된 주문은 복구할 수 없습니다.</p>
    <div className="dialog-actions">
      <button className="btn btn-secondary" onClick={close}>닫기</button>
      <button className="btn btn-danger" onClick={confirm}>주문 취소</button>
    </div>
  </div>
</div>

<aside className="drawer">
  <div className="drawer-head"><h5>알림</h5><div className="spacer" /><button className="btn btn-icon" aria-label="닫기">✕</button></div>
  <div className="drawer-body stack">…</div>
</aside>

<div className="toast-stack"><div className="toast">저장되었습니다.<div className="spacer" /><button className="btn btn-ghost btn-sm">닫기</button></div></div>
```

배너=화면에 상주하는 맥락 알림, 토스트=일시적 결과 통보(2.6초), 다이얼로그=파괴적 액션 확인, 드로어=본문을 떠나지 않는 보조 작업.

### 4.14 상태 — 로딩 · 빈 · 에러

`.skeleton` `.skeleton-line` `.skeleton-title` `.spinner` · `.empty` `.empty-mark` `.empty-title` `.empty-body`

```tsx
// 로딩 — 완성 화면과 같은 골격을 유지한다
<tr><td><span className="skeleton skeleton-line" style={{ width: 88, display: "block" }} /></td></tr>
<div className="row"><span className="spinner" /><span className="text-muted">불러오는 중…</span></div>

// 빈 상태 — 다음 행동을 하나만 제시
<div className="empty">
  <span className="empty-mark" />
  <span className="empty-title">아직 등록된 주문이 없습니다</span>
  <p className="empty-body">첫 주문을 등록하면 지표가 집계됩니다.</p>
  <button className="btn btn-primary">주문 등록</button>
</div>

// 에러 — 원인 · 요청 ID · 복구 수단
<div className="banner" data-tone="danger"><span><b>불러오지 못했습니다 (500)</b><br />잠시 후 다시 시도해 주세요.</span></div>
```

## 5. 화면 조립 패턴

모든 페이지는 이 골격을 따른다.

```tsx
<div className="page">
  <div className="page-head">
    <div>
      <h1 className="page-title">주문 관리</h1>
      <p className="page-sub">전체 1,284건</p>
    </div>
    <div className="page-actions">
      <button className="btn btn-secondary">내보내기</button>
      <button className="btn btn-primary">주문 등록</button>
    </div>
  </div>
  {/* 본문 */}
</div>
```

- **목록**: `.toolbar`(검색+필터+세그먼트) → `.table` → `.pagination`
- **상세**: `.page-head` → `.tabs` → `.grid-sidebar`( `.dl` 본문 + `.card` 사이드 )
- **폼**: `.grid-2` 안에 `.field`. 저장/취소는 `.row-end`로 하단 고정
- **대시보드**: `.grid-4` 지표 → `.grid-sidebar`(차트 + 활동 로그)

## 6. 상태는 반드시 3종을 구현한다

어떤 데이터 화면도 **로딩 / 비어있음 / 에러**를 빼먹지 않는다.

```tsx
if (isLoading) return <TableSkeleton />;          // .skeleton
if (error)     return <ErrorState onRetry={..}/>; // .banner[data-tone=danger] + 재시도
if (!rows.length) return <EmptyState/>;           // .empty + 주 액션 1개
```

## 7. 폼 검증

- 검증 시점: **blur 시 1차, 제출 시 전체**. 타이핑 중 에러 표시 금지.
- 에러는 `.field[data-invalid="true"]` + `.field-error`(필드 하단), 폼 전체 요약은 상단 `.banner[data-tone="danger"]`.
- 필수 표시는 라벨 옆 `<span className="req">*</span>`.
- 제출 중 버튼 `disabled` + `.spinner`.

## 8. 접근성

- 포커스 링 제거 금지 — `:focus-visible` 2px 빨강 유지.
- 아이콘 전용 버튼에는 `aria-label` 필수.
- 활성 메뉴 `aria-current="page"`, 탭 `role="tab"`+`aria-selected`, 정렬 헤더 `aria-sort`.
- 모달은 `role="dialog"` `aria-modal="true"`, ESC로 닫기, 포커스 트랩.
- 터치 타깃 최소 36px (모바일 44px).

## 9. 다크모드

`<html data-theme="dark">` 토글만으로 전환된다. 컴포넌트에서 다크 전용 분기를 만들지 말 것 — 토큰이 처리한다.

## 10. 파일 구조 권장

```
components/
  layout/   AppShell.tsx  Sidebar.tsx  Topbar.tsx  PageHead.tsx
  ui/       Button.tsx  Input.tsx  Table.tsx  Tag.tsx  Dialog.tsx
  state/    Empty.tsx  ErrorState.tsx  Skeleton.tsx
```

각 컴포넌트는 `className`을 조합해 반환하는 얇은 래퍼여야 한다. 내부에서 새 스타일을 정의하지 않는다.

```tsx
export function Button({ variant = "secondary", ...p }: Props) {
  return <button {...p} className={`btn btn-${variant} ${p.className ?? ""}`} />;
}
```

---

## AI 에이전트에게 주는 한 줄 지침

> "UI는 `app/globals.css`에 등록된 Modernist Kit 클래스와 CSS 변수만 사용해 구현하고,
> `DESIGN.md`의 절대 규칙 8가지를 지킬 것. 새 색·간격·라이브러리를 도입하지 말 것."

---

# §11. 프로젝트 확장 등재 (thundo.kr)

> 규칙 7("없으면 `globals.css`에 추가하고 이 문서에 등재")에 따라 이 저장소가 추가한 클래스.
> **여기에 없는 클래스를 새로 만들지 말 것.** 필요하면 먼저 이 표에 추가한다.
> 확장 클래스도 토큰만 사용한다(하드코딩 색·간격 금지).

| § | 클래스 | 용도 |
|---|--------|------|
| 11.1 | `.container` `.container-narrow` `.page-narrow` | 공개 사이트용 가운데 정렬 컨테이너(1180 / 760 / 820). **세로 여백(`--space-8`)을 컨테이너가 책임진다 — 페이지에서 인라인 padding 을 따로 주지 말 것.** 앱 화면은 키트 `.page` 사용 |
| 11.1 | `.grid-auto` `.grid-auto-sm` | 최소폭 기반 그리드(150px / 104px, **auto-fit**). 키트 `.grid-2/3/4` 는 900px 이하에서 **1열로 붕괴**하므로 지표 행·카드 목록처럼 좁은 화면에서도 2열을 유지해야 하는 곳은 이것을 쓴다 |
| 11.2 | `.site-header` `.site-header-inner` `.site-brand` `.topnav` `.nav-divider` `.site-footer` `.skip-link` `.only-wide` `.only-narrow` `.pt-safe` `.pb-safe` `.no-overscroll` + **700px 이하 보정**(`.page-head` 줄바꿈, `.dl` 1열) | 공개 사이트 가로 헤더·푸터. 내비 항목 자체는 키트 `.nav-item` 재사용. `.only-wide`/`.only-narrow` 는 700px 경계 표시 토글(키트에 반응형 유틸이 없어 추가 — 컴포넌트에 미디어쿼리 금지). iPhone standalone 안전영역은 기능 보정 |
| 11.3 | `.article` | 긴 본문 타이포(블로그 본문·에디터 프리뷰·AI 답변). `@tailwindcss/typography`(`prose`) 대체. 목차 앵커용 `scroll-margin-top` 과 인쇄 규칙(`@media print` — 크롬 숨김 + 흰 바닥 강제)을 함께 정의한다 |
| 11.4 | `.card-link` `.stat-unit` `.avatar-xl` `.table-scroll` | 카드 전체 링크, 지표 숫자 옆 단위(줄바꿈 방지), 104px 프로필 아바타, 모바일 표 가로 스크롤. `a:where(.tag,.page-btn,.stat,.nav-item,.btn)` 의 기본 밑줄 제거도 여기서 한다 |
| 11.4 | `.play-badge` | 포스터 위 재생 어피던스(장식용 span). 실제 버튼은 포스터 전체이므로 `.btn-primary` 를 쓰면 안 된다 — 카드 수만큼 강조색이 도배된다(규칙 5) |
| 11.5 | `.chat-log` `.bubble` `.bubble-user` `.bubble-agent` `.chat-composer` `.chat-agent-select` `.chat-input-row` | 어드민 에이전트 채팅(좁은 폭에선 에이전트 선택이 제 줄로 wrap). `.chat-input-row` 는 입력칸+전송을 한 덩어리로 묶는다 — 셋을 그냥 wrap 시키면 남는 폭에 따라 **전송 버튼만** 다음 줄 왼쪽으로 떨어져 나간다(430px·768px 실측. `.btn` 은 `flex: none` 이라 눌러 담을 수 없다). 래퍼가 `flex: 1 1 12rem` 로 늘어나므로 넓은 화면의 3열 배치는 그대로다 |
| 11.6 | `.chart` `.chart-empty` `.legend` `.legend-row` `.legend-mark` `.legend-value` | 순수 SVG 차트(외부 차트 라이브러리 0). 막대는 키트 `.progress` 재사용 |
| 11.7 | `.canvas-stage` `.checkerboard` `.range` `.crop-guide` | 이미지 편집기(`/run`) 캔버스 무대, 투명 영역 체커보드(장식 아닌 기능 — 토큰에서 파생), 범위 슬라이더, 크롭 가이드(저장될 영역 테두리 + 바깥 딤) |
| 11.8 | `.scroll-y` | 셸 본문 안 고정 높이 스크롤 영역 |
| 11.9 | `.reading-detail` `.cell-wrap` | 관제 표(`/saju/amond`) 안 긴 본문·다중값 셀의 폭 상한. `.table` 은 auto layout 이라 셀의 max-content 가 곧 표 폭이다 — 상한이 없으면 판독문 길이만큼 표가 넓어진다. `.reading-detail` 은 펼친 판독 행을 좌측 고정(sticky)해 화면 폭으로 묶고(줄 길이 상한은 안쪽 `.article` 담당), `.cell-wrap` 은 운 항목·타로 카드처럼 값이 이어 붙는 셀의 상한(12rem)을 **셀이 아니라 안쪽 블록에** 건다(table-cell 의 `max-width` 는 무시된다). 하한(`min-width`)은 주지 않는다 — 표가 560px 계약을 넘어 넓어져 폰에서 그 열이 화면 밖으로 밀린다(실측) |
| 11.10 | `.date-strip` `.stat-wide` | 에이전트 일지(`/reports`). `.date-strip` 은 날짜 칩 7개를 한 줄 가로 스크롤로 묶는다 — 접히게 두면 폰에서 3줄로 흩어져 화면 위쪽을 다 먹는다(달력 스트립 관례). `.stat-wide` 는 추이 그래프처럼 성격이 다른 칸이 좁은 화면(≤700px)에서 한 칸만 차지해 옆이 비는 것을 막는다. ⚠ **넓은 폭까지 전폭으로 두면 안 된다** — `.grid-auto`(auto-fit)의 빈 트랙 접힘이 영구히 꺼져 KPI 5칸이 한 줄에 모이지 못하고 오른쪽이 통째로 빈다(1280px 에서 499px 공백, 실측). 그래서 미디어쿼리 안에만 둔다 |
| 11.11 | `.dialog-head` (+ 코어 `.dialog`·`.dialog > *` 의 `min-width: 0`) | 다이얼로그 머리글 행 — 제목·상태·부가 태그·닫기를 좁은 폭에선 줄바꿈으로 받는다. `.btn` 은 flex:none 이라 눌러 담는 선택지가 없다 |
| 11.12 | `.portfolio-card` | 포트폴리오 분류 탭의 접힌 아코디언 카드 높이를 통일한다. 제목은 한 줄, 요약은 두 줄로 제한하고 펼친 상태는 콘텐츠 길이에 맞춰 확장한다 |
| 11.13 | `.qa-log` | 홈 방문자 Q&A 대화 로그의 고정 높이 스크롤 영역. 메시지가 쌓일 때마다 카드가 늘어나 아래 인기글이 밀려 내려가던 것을 막고, 데스크톱에선 카드 하단이 우측 사이드바(기술 스택) 끝선과 맞도록 상한을 잡는다. ⚠ 11.5 의 `.chat-log`(관리자 채팅)와 **이름을 공유하면 안 된다** — 그쪽 `flex: 1` 이 만드는 `flex-basis: 0` 이 `height` 를 덮어 높이가 잡히지 않는다(실측). 그래서 `flex: none` 을 함께 준다 |
| 11.14 | `.portfolio-card-actions` `.editor-body` | 포트폴리오 미리보기 2 의 관리자 조작. `.portfolio-card-actions` 는 카드 아래 붙는 수정·삭제 줄 — 카드가 `.grid-2` 안에서 높이를 맞추므로 조작 줄을 카드 **밖**에 두고 좁은 폭에선 버튼이 제 줄을 갖게 wrap 한다. `.editor-body` 는 수정 다이얼로그 본문 — 필드가 10개라 화면 높이를 넘기면 모달 자체가 잘린다(다이얼로그엔 스크롤이 없다). 본문만 스크롤시켜 머리글·확인 버튼이 항상 보이게 한다 |

# §12. 이 저장소의 적용 규칙

1. **CSS 진입점은 `web/src/app/globals.css` 하나.** 페이지·버티컬별 CSS 파일(`saju.css` 등)을 만들지 않는다.
2. **Tailwind · Radix Themes 금지.** `tailwindcss`, `@tailwindcss/typography`, `@radix-ui/themes` 는 제거됐다. 다시 설치하지 않는다.
   - Tailwind 유틸 클래스(`flex`, `text-sm`, `bg-surface-0`, `md:hidden` …)를 쓰지 않는다. 레이아웃은 `.row`/`.stack`/`.grid-*`.
3. **아이콘은 `lucide-react`.** 이모지·기하문자(`◈` `✎` `🦁` …)를 UI에 쓰지 않는다. 크기 16/18/20px.
4. **테마**: `<html data-theme="light">` 기본. 토글은 `ThemeToggle` 컴포넌트가 `data-theme` 와 `localStorage.theme` 만 바꾼다. 컴포넌트에 다크 분기 금지.
5. **인라인 `style` 은 치수 한정.** 키트 예시처럼 `style={{ width: 240 }}` 수준의 치수·비율만 허용. 색·폰트·그림자는 반드시 클래스나 `var(--*)`.
6. **컴포넌트 위치**: `components/layout/`(셸·헤더·푸터), `components/ui/`(원자), `components/state/`(로딩·빈·에러). 래퍼는 `className` 조합만 하고 새 스타일을 정의하지 않는다.
7. **데이터 화면은 상태 3종 필수** — 로딩(`.skeleton`) / 빈(`.empty`) / 에러(`.banner[data-tone=danger]` + 재시도).
8. **가드는 테스트로 강제된다.** `npm run test:design` (`src/test/design-guard.test.ts`) 이 위 규칙을 소스 스캔으로 검사한다. 실패하면 머지 금지.
   - 검사 대상은 **화면을 그리는 소스**(`src/app/**`, `src/components/**` — `app/api/**` 제외)다. `src/server/**`·`src/lib/**` 의 이모지·색 리터럴은 UI 가 아니라 Slack/Discord 알림 문구·LLM 프롬프트·데이터이므로 대상이 아니다.
   - 대신 **데이터로 흘러든 이모지는 브라우저에서 잡는다** — `npm run test:e2e` 가 렌더된 DOM 의 텍스트 노드를 검사한다. 서버·라이브러리가 이모지 필드를 내보내도 **UI 는 그것을 렌더하지 않는다.**

9. **정본 예시의 글리프는 Lucide 로 대체한다.** §4 카탈로그 마크업은 `✓` `✕` `≡` `⋯` `◀` `▶` 같은 문자를 쓰지만, 규칙 8(이모지·기하문자 금지)이 이 저장소에서는 더 강하다. 아래 매핑을 고정한다 — 프로젝트 전체에서 같은 아이콘을 쓴다.

   | 정본 글리프 | 용도 | 이 저장소 |
   |---|---|---|
   | `✓` | 체크박스(`.check .box`), 완료 | `<Check size={11} />` (currentColor 상속 → `.box` 색 전환 그대로 동작) |
   | `✕` | 닫기, 칩 제거 | `<X size={16/20} />` + `aria-label` |
   | `≡` | 사이드바 접기·메뉴 | `<Menu size={20} />` + `aria-label` |
   | `⋯` | 더보기 | `<MoreHorizontal size={18} />` + `aria-label` |
   | `◀` `▶` | 페이지네이션 이전/다음 | `<ChevronLeft/ChevronRight size={16} />` |
   | `←` | 뒤로 | `<ArrowLeft size={16} />` |
   | `▲` `▼` | 지표 증감(`.stat-delta`) | `<TrendingUp/TrendingDown size={14} />` |

   CSS 안의 `content: "✓"` / `content: "▾"`(`.stepper`, `.accordion`)는 globals.css 의 정본 그대로 둔다 — 마크업이 아니라 장식이라 가드 대상이 아니다.

11. **규칙 6(사진 흑백)은 적용하지 않는다.** 콘텐츠 사진은 **원색**으로 둔다 — 영상 썸네일·프로필 사진·에이전트 초상 등.

    2026-07-30 사용자 결정. 이유:
    - 사이트 전체가 흑백으로 보인다는 실사용 피드백. 키트 팔레트가 이미 중성 회색 + 빨강 액센트 하나라, 여기에 사진까지 탈색하면 **화면에서 색이 완전히 사라진다.**
    - `VideoFacade` 는 카드 래퍼에 필터가 걸려 있어 포스터뿐 아니라 **재생 중인 유튜브 iframe 과 재생 배지의 강조색까지** 함께 탈색됐다. 사진 처리 규칙이 영상 재생 품질을 망가뜨렸다.
    - 영상 썸네일·인물 사진은 장식 이미지가 아니라 **콘텐츠**다. 정보를 담은 이미지의 색을 지우면 식별성이 떨어진다.

    `.grayscale` 클래스 자체는 globals.css 에 남겨둔다 — 장식 목적의 배경 이미지에 쓸 여지는 있다. 다만 **콘텐츠 사진에는 쓰지 않는다.**

10. **캔버스 픽셀 값은 색 규칙의 예외다(줄/선언 단위 표시 필수).** `/run` 이미지 편집기는 사용자가 고르는 색 **자체가 제품 데이터**(팔레트·배경 채우기·허용 오차)이므로 토큰으로 바꿀 수 없다. 파일 전체를 면제하지 않고 선언 단위로만 표시한다.

    ```tsx
    // design-guard: 레이어 색상 변경 알고리즘에 그대로 전달되는 프리셋(픽셀 처리 데이터), UI 장식색 아님
    const PRESET_COLORS = [{ label: '흰색', value: '#ffffff' }, …];
    ```

    - 표시는 선언 바로 위(또는 같은 줄)에 두면 **그 선언문 끝(`;`)까지** 적용된다.
    - 이유에 `픽셀`(또는 `pixel`)을 반드시 적는다 — `grep -rn "design-guard:" src/` 로 전수 감사할 수 있어야 한다.
    - 가드는 이 예외가 **이미지 편집기 파일 밖에서 쓰이면 실패**한다(남용 차단). UI 장식 목적의 색은 예외 없이 토큰을 쓴다.

# §13. AI 코딩 에이전트 지침 (이 저장소)

> UI는 `web/src/app/globals.css` 에 등록된 Modernist Kit 클래스·CSS 변수와 §11 확장만 사용해 구현한다.
> 절대 규칙 8가지와 §12 를 지킨다. 새 색·간격·CSS 파일·UI 라이브러리를 도입하지 않는다.
> 새 UI를 만들기 전 `components/ui/`·`components/layout/`·`components/state/` 에 쓸 수 있는 래퍼가 있는지 먼저 확인한다.
> 구현 후 `npm run test:design` 과 `npm run test` 를 돌려 통과를 확인한다.
> 레이아웃을 건드렸으면 `npm run test:ui` 로 **실브라우저 전수 감사**까지 돌린다(아래).

# §14. 실브라우저 UI 감사 (`npm run test:ui`)

`test:design` 은 소스를 읽는 정적 검사라 **렌더 결과**는 못 본다. 폰에서 글자가 세로로 쌓이거나
행이 화면 밖으로 나가는 사고는 전부 정적 검사를 통과한 채로 나갔다. 그래서 실제 브라우저로
27개 라우트 × 3뷰포트(390/768/1280) + 클릭해야 열리는 상태(상세 다이얼로그·새 요청·채팅 입력)를
돌며 3종을 잡는다.

| 검출 | 판정 |
|------|------|
| 가로 오버플로 | `documentElement.scrollWidth > innerWidth` |
| 세로 꺾임 | 텍스트 줄 상자를 y 로 묶어 실제 줄 수를 세고, 줄당 글자수가 3.2자 이하면 위반. 단 요소 자신의 박스가 넓으면(문단 안 인라인이 어절 경계에서 접힌 것) 정상 흐름으로 본다 |
| 뷰포트 이탈 | 보이는 잎 요소의 `right` 가 뷰포트를 넘음. 가로 스크롤 컨테이너 안은 제외 |

```bash
AUDIT_ID=… AUDIT_PW=… AUDIT_BASE=http://localhost:3190 \
  CHROMIUM_LIBS=…/vendor/chromium-libs/root/usr/lib/x86_64-linux-gnu \
  npm run test:ui
```

선택: `SHOTS_DIR`(위반 스크린샷 저장 경로, 기본 `/tmp/ui-shots`).

⚠ **세션이 죽으면 보호 라우트가 전부 로그인 화면으로 바뀌어 "전 라우트 통과"가 찍힌다**(거짓 green).
하네스는 착지 URL 을 확인해 로그인/인증오류로 튕기면 실패로 올린다. 결과 페이지가 선행 입력이
없어 부모로 돌아가는 것은 정상이라 건너뛴다. 프로덕션 번들로 검증할 땐 `.next/standalone` 에
`static`·`public` 을 복사해야 한다 — 안 하면 JS 가 전부 404 라 폼이 아예 렌더되지 않는다.
