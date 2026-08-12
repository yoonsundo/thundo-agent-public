# LLM 위키 방법론 (Karpathy LLM Wiki 패턴)

> 이 페이지는 **방법론 reference**다. Meerkat 관제탑과 모든 에이전트가 따르는 지식관리 패턴의
> 원천 정리. 출처는 하단 참조. 본 프로젝트의 적용 규칙은 [SCHEMA.md](SCHEMA.md) 참조.

## 한 줄 정의

LLM이 원문을 한 번 읽고 **핵심을 추출해 영속 마크다운 위키에 점진 통합**하여, 질문마다 다시
유도하지 않고 **복리로 축적되는 지식 베이스**를 만드는 패턴. Andrej Karpathy 제안.

## RAG와의 근본 차이

| | RAG | LLM 위키 |
|---|-----|---------|
| 지식 처리 | 쿼리마다 원문 청크 **재검색·재유도** | 한 번 컴파일 후 **최신 상태로 유지** |
| 누적 | 없음 (매번 처음부터) | **복리 축적**(compounding artifact) |
| 결과물 | 휘발 | 영속 마크다운 |
| 북키핑 비용 | — | LLM이 **거의 0**으로 낮춤 |

> "Knowledge is compiled once and then kept current, not re-derived on every query."

## 3계층 아키텍처

1. **원문 소스 (Raw Sources)** — 불변. 기사·논문·코드·런 결과. LLM은 **읽기만**, 수정 안 함.
   → 본 프로젝트: `runs/**`, `published/**`, `benchmark/**`, 외부 출처 URL.
2. **위키 (Wiki)** — LLM이 소유·생성·갱신하는 마크다운(요약·엔티티·개념 페이지·교차참조).
   → 본 프로젝트: `docs/llm-wiki/**`.
3. **스키마 (Schema)** — 위키 구조·규칙·워크플로우를 LLM에게 알려주는 설정 문서.
   → 본 프로젝트: [SCHEMA.md](SCHEMA.md) + 루트 `CLAUDE.md`.

## 핵심 작업 3종

- **Ingest(흡수)** — 새 소스를 **한 번에 하나씩** 처리. 원문 읽기 → 요약 페이지 작성 →
  index 갱신 → 관련 엔티티/개념 페이지(보통 10~15개) 갱신 → log에 항목 append.
- **Query(질의)** — index를 먼저 읽고 관련 페이지를 종합해 **출처와 함께** 답한다.
  가치 있는 답은 새 위키 페이지로 저장되어 지식이 더 축적된다.
- **Lint(점검)** — 모순·낡은 주장·고아 페이지·교차참조 누락·데이터 공백을 주기 점검.
  **하드 모순은 사람이 해소할 때까지 ingest 차단**(심각도 분류).

## 색인·로그

- **index.md** — content 카탈로그. 모든 페이지를 한 줄 요약으로 카테고리별 나열. 쿼리 시 **먼저** 읽음.
- **log.md** — append-only 연대기. ingest/query/lint를 접두어로 기록(단순 파싱).

## 출처 무결성·검증

- 원문 불변성으로 무결성 유지: 합성은 **위키 계층에서만** 일어나 환각이 원문을 오염시키지 않음.
- 새 주장 ↔ 원문 모순은 ingest 시점에 표면화 → 심각도 부여 → **하드 모순은 차단**.

## 역할 분담 (사람 ↔ LLM)

- **사람**: 소싱·탐색·질문 던지기·합성 결과 리뷰 (방향 결정).
- **LLM**: 요약·교차참조·파일링·북키핑 — 사람이 지쳐 포기하던 잡일.
- 결과: "사람이 옳은 질문을 던지고, LLM이 grunt work를 한다." 유지비용 ≈ 0.

## 본 프로젝트의 핵심 적응 (governance 제약)

원 패턴은 LLM이 위키를 **직접 write**한다. 그러나 본 프로젝트는 "AI는 자기 감시장치를
고치지 않는다 / 자기채점 금지 / 감독은 제안전용"이 불변 원칙이다. 따라서:

- **Meerkat(관제탑)**은 위키를 **읽고·질의·lint**하되 변경은 **lion에게 제안**한다(Write 없음).
- 위키 적용(write)은 lion 또는 사람이 수행 — crane/elephant의 "진단·제안만, 적용은 외부"와 동일.
- Meerkat은 **자기 자신의 준수를 스스로 판정하지 않는다**(결정론 감사 스크립트 + elephant/사람이 판정).

## 출처

- Andrej Karpathy, "LLM Wiki" gist — <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>
- GeekNews(hada.io) 정리 — <https://news.hada.io/topic?id=28208>
- 「LLM위키 완벽 가이드」(wikidocs book) — <https://wikidocs.net/book/19830>
