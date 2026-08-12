# 개념 — 결정론 품질 게이트 16종

> 초안이 발행 가능 여부를 판단하는 **결정론 단계(STEP 4)**. LLM 비결정성을 배제하고
> 규칙 기반 스크립트만으로 pass/fail을 확정한다.
> 출처: `scripts/gates/**` 실제 구현 + `CLAUDE.md` "결정론 게이트 16종" 표. (⚠ 이 문서는 13종 시절 작성 — 표가 최신 16종보다 적을 수 있다. 정본은 `scripts/gates/run-all-gates.mjs` GATE_SCRIPTS.)

## 게이트 일람

| # | 게이트 이름 | 판정 기준 | 임계값 | 스크립트 |
|---|-------------|-----------|--------|----------|
| 1 | dup | 문자 4-gram MinHash(k=128) Jaccard로 `published/` 기존 글과 중복 여부 검사 | `max_jaccard > 0.25` → fail (기본값; `config/pipeline.json` 오버라이드 가능) | `scripts/gates/check-dup.mjs` |
| 2 | length | 코드블록·HTML 제거 후 한글 음절(U+AC00–U+D7A3) 개수 계산 | `< 1500` 또는 `> 2000` → fail (`config/pipeline.json` 오버라이드 가능) | `scripts/gates/check-length.mjs` |
| 3 | banned | `config/banned-terms.txt` 패턴(정규식) 매칭 | 1건 이상 히트 → fail | `scripts/gates/check-banned.mjs` |
| 4 | lint | H1 정확히 1개, 헤딩 앞뒤 빈 줄 (markdownlint-cli2 설치 시 우선 사용, 없으면 내장 간이 린트) | 규칙 위반 1건 이상 → fail | `scripts/gates/check-lint.mjs` |
| 5 | links | 본문 마크다운 링크 전부 HEAD 요청(timeout 10 s) → 2xx 확인. assertionGuard: 단정 문장 중 링크 없는 비율이 임계 초과이면 인용세탁으로 판정 | 링크 HTTP 비-2xx 또는 `assertion_unlinkd_ratio > 0.6` → fail | `scripts/gates/check-links.mjs` |
| 6 | empty | `##` 섹션 본문(하위 헤딩 포함)이 지나치게 짧으면 빈 섹션으로 판정 | 섹션 본문 `< 50자` → fail | `scripts/gates/check-empty.mjs` |
| 7 | ai-tells | 한국어 AI-티 신호 탐지. S1(결정적 신호): 표현 1건 이상 → 즉시 fail. S2(약한 신호): 종류 2종 이상 → fail | S1 ≥ 1건 OR S2 종류 ≥ 2 → fail | `scripts/gates/check-ai-tells.mjs` |
| 8 | sources | frontmatter `source_refs` 항목 중 `url` 빈 문자열 탐지. 본문에 기관명+통계수치 패턴이 있는데 유효 URL이 없으면 출처 세탁으로 판정 (순수 1인칭 경험 수치는 통과) | 빈 URL 1건 이상 OR 기관통계 무출처 → fail | `scripts/gates/check-sources.mjs` |
| 9 | credibility | 1인칭 경험 앵커 표현이 임계 이상인데 구체 증거 토큰(숫자·날짜·고유명사 등)이 부족하면 가짜 전문성으로 판정 | 앵커 `≥ 5` AND 구체 증거 토큰 `< 5` → fail | `scripts/gates/check-credibility.mjs` |
| 10 | density | 문장 단위 분리 후 구체 토큰(수치·영문 고유명사·한글 수량사·시간 기준어) 포함 문장 비율 측정 | `concrete_sentence_ratio < 0.05` → fail | `scripts/gates/check-density.mjs` |
| 11 | hedge | 헤징 종결 문장 비율(`hedge_ratio`)이 높고 구체 증거 토큰이 0개이면 입장 없는 글로 판정 | `hedge_ratio > 0.35` AND `concrete_count == 0` → fail | `scripts/gates/check-hedge.mjs` |
| 12 | internal-dup | 본문을 `##` 섹션 단위로 분리 후 섹션 쌍 간 4-gram Jaccard 최대값 계산, 임계 초과이면 내부 재진술로 판정 | `max_pair_jaccard > 0.107` → fail | `scripts/gates/check-internal-dup.mjs` |
| 13 | niche | 본문 문단 중 니치 키워드(AI·자동화·LLM 등) 포함 문단의 어절 수 비율 계산, 임계 미만이면 주제이탈로 판정 | `niche_keyword_ratio < 0.40` → fail | `scripts/gates/check-niche.mjs` |

## exit 계약

모든 게이트 스크립트는 동일한 exit 계약을 따른다.

| exit 코드 | 의미 |
|-----------|------|
| `0` | 통과 (pass) |
| `1` | 실패 (fail) — 발행 차단 |
| `2` | 실행 오류 — 스크립트 자체 오류 (파일 미존재·파싱 실패 등) |

stdout은 항상 JSON 1줄로 출력된다. stderr는 실행 오류 메시지에만 사용한다.

13종 일괄 실행:

```bash
npm run gate <초안파일.md>
# 내부적으로 scripts/gates/run-all-gates.mjs 를 호출
```

개별 게이트 직접 실행:

```bash
node scripts/gates/check-dup.mjs runs/<date>/drafts/draft-xxx.md
```

## 파이프라인 내 위치

게이트 13종은 **STEP 4** (작가 초안 생성 후, 검증자 4명 병렬 실행 전)에 순차 실행된다.
하나라도 exit 1이 나오면 해당 초안은 retry 또는 폐기 경로로 분기된다.

```
STEP 3 작가 초안 생성
  ↓
STEP 4 결정론 게이트 13종  ← 여기
  ↓ (전원 exit 0)
STEP 5 검증자 4명 병렬 (eagle·bee·swan·raven)
```

## 임계값 캘리브레이션

각 스크립트 상단 주석에 캘리브레이션 근거가 명시되어 있다. 임계값은
`benchmark/seed/` 양품 30편(good-01~30)을 전부 통과시키고,
`benchmark/negative/` 부정 앵커 5편을 확실히 차단하도록 설정되었다.

### 16. source-fidelity (2026-08-11 신설, S3a shadow)

외부 귀속 수치(기관명·"~에 따르면" 문장 내 수치)가 소스 발췌(excerpt)에 실재하는지 대조하고, 소스 표절(4-gram Jaccard>0.107 또는 연속 일치 ≥40자)을 차단한다. 1인칭 경험 수치는 제외(게이트 9·10 영역). 조인: 초안 `writer` → `runs/<date>/topics/selection.json` `pool_index` → pool `excerpt_file`. 5상태(no-pack skip / pack-ignored·pack-lost·pack-unresolved fail / 정상대조). `config/source-pack.json` `gate_enforce:false`(기본)면 shadow — 판정을 pass 로 내되 `evidence.shadow_verdict` 를 남긴다. 스크립트: `scripts/gates/check-source-fidelity.mjs`.

임계값 변경은 `benchmark/seed/` 전체 회귀 통과를 확인한 후에만 허용한다.

## 관련

- [pipeline.md](pipeline.md)
- [agent-contract.md](agent-contract.md)
- [../entities/agent-registry.md](../entities/agent-registry.md)
