# AGENTS.md — thundorun 작업 규칙 (모든 코딩 에이전트 공통)

프로젝트 전반 규칙은 `CLAUDE.md`, 파이프라인은 `agents/pipeline.md` 를 본다.
이 파일은 **UI 를 만지는 모든 작업에 걸리는 단일 게이트**다.

## UI 는 Modernist Kit 으로만 만든다

1. 작업 전 **`/DESIGN.md`**(정본)와 **`web/src/app/globals.css`**(사용 가능한 클래스의 유일한 출처)를 읽는다.
2. 사용 가능한 것: `globals.css` 에 등록된 키트 클래스 + `DESIGN.md §11` 확장 + CSS 변수(`var(--color-*)`, `var(--space-*)`, `var(--radius-*)`).
3. **금지**: Tailwind CSS(유틸 클래스 포함) · `@radix-ui/themes` · CSS-in-JS · styled-components · 새 UI 라이브러리 · 페이지별 CSS 파일 · 이모지 · 하드코딩 색/간격/반경 · 배경 그라디언트 · 히어로 카피 가운데 정렬.
4. 아이콘은 `lucide-react` 만(16/18/20px). 테마는 `<html data-theme>` 토글 — 컴포넌트에 다크 분기를 만들지 않는다.
5. 데이터 화면은 **로딩 / 빈 / 에러** 3종 상태를 반드시 구현한다(`web/src/components/state/*` 재사용).
6. 새 클래스가 꼭 필요하면 `globals.css` 의 `PROJECT EXTENSIONS` 절에 추가하고 **`DESIGN.md §11` 표에 등재**한다. 등재 없는 클래스는 가드가 막는다.

## 완료 전 반드시 통과할 것

```bash
cd web
npm run scan:secrets  # 크리덴셜 유출 차단 (커밋 전 필수)
npm run test:design   # 키트 규칙 가드 (미등재 클래스·Tailwind·이모지·하드코딩 색 차단)
npm run test          # 단위·컴포넌트 테스트
npm run typecheck
npm run build
npm run test:e2e      # 브라우저 실측 (선택 — UI 변경 시 권장)
npm run check:live    # 배포 후 실측 (선택 — 데이터 많을 때만 드러나는 결함 검출)
```

## 시크릿은 절대 커밋하지 않는다

- 값이 든 파일은 `.gitignore` 가 차단한다(`.env*`, `*.pem/*.p12/*.key`, `*-sa.json`, `**/session-state.json`). 템플릿은 `.env.example` 만 예외로 추적한다.
- 소스에 시크릿 형태 문자열을 박지 않는다. 테스트용 값이 필요하면 **고정 입력에서 파생**한다 (`web/e2e/secret.ts` 가 `sha256('thundorun-local-e2e-only')` 로 만들고 `playwright.config.ts`·E2E 스펙이 그 값을 공유한다). 무작위 생성은 쓸 수 없다 — 세션 쿠키를 직접 서명하는 스펙과 서버가 **같은 값**이어야 한다.
- `npm run scan:secrets` 는 **저장소 루트 전체**를 파일명이 아니라 **내용**으로 본다(`--staged` 는 index blob 을 읽어 실제로 커밋될 내용을 검사한다)(`tokens.jsonl` 처럼 이름만 수상한 파일에 속지 않는다). 위반은 `파일:줄 + 패턴 이름`까지만 보고하고 **값은 출력하지 않는다**.
- 문서가 패턴을 인용하는 정당한 경우는 그 줄에 `secret-scan: allow <이유>` 를 단다 — **이유가 없거나 산문(.md/.txt) 밖이면 실패**한다. 사용 현황은 스캔 성공 시 매번 출력된다.
- 정규식 스캐너는 만능이 아니다. 쪼갠 키·base64 로 감싼 키·이름이 평범한 불투명 값은 못 잡는다 — 스크립트 헤더에 한계를 명시해 뒀다.
- **이미 커밋했다면 이력에서 지우는 것으로 끝내지 말고 키를 폐기·재발급한다** — 푸시된 순간 유출로 간주한다.

가드가 실패하면 머지·배포 금지. 규칙을 바꾸고 싶으면 `DESIGN.md` 를 먼저 고치고 가드를 함께 수정한다.
