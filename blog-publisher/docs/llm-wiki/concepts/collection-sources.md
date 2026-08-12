# 개념 — 주제 수집 소스

> STEP 1에서 Magpie(Reddit+HN), Cheetah(트렌드), Owl(깊이)이 병렬로 주제를 수집한다.
> 본 문서는 외부 소스별 엔드포인트·인증·제약을 정의한다.
> 출처: `scripts/reddit/**` (`fetch.mjs`, `hn.mjs`, `normalize.mjs`), `CLAUDE.md`.

## 소스 요약표

| 소스 | 엔드포인트 | 인증 | 제약·fallback | 담당 에이전트 |
|------|-----------|------|--------------|--------------|
| Reddit | `https://www.reddit.com/r/<subreddit>.rss` (Atom 피드) | 없음 (공개 RSS) | `.json` 엔드포인트는 데이터센터 IP에서 HTTP 403 차단 → `.rss` 고정 사용 | Magpie |
| Hacker News | `https://hn.algolia.com/api/v1/search` (Algolia API) | 없음 (무인증 공개 GET) | 보조 소스. 쿼리 파라미터로 태그·정렬·기간 지정 | Magpie |

## 소스별 상세

### Reddit

- **피드 형식**: RSS Atom (`.rss`). XML 파싱 후 `fetch.mjs`가 제목·URL·본문 추출.
- **엔드포인트 선택 배경**: Reddit `.json` API는 데이터센터 IP 대역에서 `HTTP 403`을 반환한다. CI/CD 환경과 서버 배포 모두 해당 제약을 받으므로, 공개 RSS Atom 피드(`.rss`)만 사용한다.
- **정규화**: `normalize.mjs`가 Reddit·HN 원문을 공통 스키마(`{title, url, source, score, collected_at}`)로 변환.

### Hacker News

- **API**: `hn.algolia.com` — Algolia 공개 검색 API. 무인증 공개 GET.
- **구현 파일**: `hn.mjs`. 쿼리·태그(`story`)·날짜 범위를 파라미터로 전달.
- **역할**: Reddit 수집 결과를 보완하는 보조 소스. 기술·AI 주제 깊이 확보에 활용.

### 수집 이후 흐름

```
STEP 1  fetch.mjs / hn.mjs  →  normalize.mjs  →  공통 주제 후보 배열
STEP 2  Lion이 중복 제거(dedup_key) + seed backfill → 주제 3건 선정
```

## COLLECT_LIVE 모드

`COLLECT_LIVE=1` 환경변수는 `RUN_MODE`와 **독립적**으로 동작한다.

| 변수 | 역할 |
|------|------|
| `RUN_MODE=mock` | LLM 호출·발행을 모두 mock으로 처리 |
| `COLLECT_LIVE=1` | 수집 단계만 실제 외부 HTTP 요청 수행 |

두 변수를 함께 쓰면 Reddit RSS + HN Algolia는 실제 수집하되, LLM 초안 생성과 발행은 mock으로 유지된다. LLM·발행 크리덴셜 없이도 수집 로직을 검증할 수 있다.

```bash
# 실수집 + mock 파이프라인
COLLECT_LIVE=1 RUN_MODE=mock node scripts/run-lion.mjs
npm run pipeline:collect
```

## 구현 파일 목록 (`scripts/reddit/`)

| 파일 | 역할 |
|------|------|
| `fetch.mjs` | Reddit RSS Atom 피드 HTTP 요청·파싱 |
| `hn.mjs` | Hacker News Algolia API 요청·파싱 |
| `normalize.mjs` | Reddit·HN 원문 → 공통 주제 스키마 변환 |

## 관련

- [pipeline.md](pipeline.md)
- [../entities/agent-registry.md](../entities/agent-registry.md)
