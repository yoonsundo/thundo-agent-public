#!/usr/bin/env node
/**
 * keyword-demand.test.mjs — 검색 수요 키워드 폐루프 스모크
 *
 * 잠그는 것:
 *   [1] 데이터랩 배치 계획·앵커 정규화 (순수)
 *   [2] 후보 수집·기회 점수·최종 점수 (순수)
 *   [3] mock e2e — 격리 cwd 에서 산출물 3종 + mock 오염 방지(loadDemandCandidates 거부)
 *   [4] no-cred graceful — 크리덴셜 없으면 warn+exit 0, candidates 미생성
 *   [5] apply-targeting 병합 — demand 신규 추가·상한·tier 가중치·기존 무손상
 *
 * 실행: node scripts/test/keyword-demand.test.mjs
 * (외부 의존 없음 — [3b]만 가짜 크리덴셜로 실호출을 시도하나 401/실패가 곧 기대 결과라 네트워크 유무와 무관)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.RUN_MODE = 'mock';

const { planBatches, normalizeWithAnchor, CANDIDATES_PER_CALL } = await import('../seo/datalab.mjs');
const { discoverCandidates, scoreOpportunity, finalScore, parseTags, loadDemandCandidates, markDemandConsumed, isNicheKeyword, buildReport } =
  await import('../seo/keyword-demand.mjs');
const { buildNewKeywords } = await import('../seo/apply-targeting.mjs');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const eq  = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `${JSON.stringify(a)} != ${JSON.stringify(b)}`));

console.log('[1] 데이터랩 배치·앵커 정규화');
{
  const batches = planBatches(['a코딩', 'b코딩', 'c코딩', 'd코딩', 'e코딩', 'A코딩'], 'anchor');
  eq(batches.length, 2, `5후보(대소문자 dedup) → ${CANDIDATES_PER_CALL}개씩 2배치`);
  eq(batches[0][0], 'anchor', '모든 배치 선두에 앵커');
  eq(batches[1].length, 2, '마지막 배치 = 앵커+잔여1');

  const scores = normalizeWithAnchor([
    { keywords: ['anchor', 'x', 'y'], results: [
      { title: 'anchor', ratios: [50, 50] }, { title: 'x', ratios: [100, 100] }, { title: 'y', ratios: [25, 25] },
    ] },
    { keywords: ['anchor', 'z', 'w'], results: [
      { title: 'anchor', ratios: [10] }, { title: 'z', ratios: [10] },
      // w 는 응답에서 누락(수요 미달) → 0
    ] },
  ], 'anchor');
  eq(scores.get('x'), 2, '앵커 대비 2배');
  eq(scores.get('y'), 0.5, '앵커 대비 0.5배 — 배치가 달라도 비교 가능');
  eq(scores.get('z'), 1, '다른 배치의 1배와 첫 배치 점수가 같은 축');
  eq(scores.get('w'), 0, '응답 누락 키워드 = 수요 0');

  const dead = normalizeWithAnchor([
    { keywords: ['anchor', 'q'], results: [{ title: 'anchor', ratios: [0, 0] }, { title: 'q', ratios: [30] }] },
  ], 'anchor');
  eq(dead.get('q'), null, '앵커 ratio 0 배치 → null(측정불능, 0점 아님)');
}

console.log('[2] 후보 수집·점수 (순수)');
{
  const c = discoverCandidates({
    gscQueries: ['claude code 사용법', '김치찌개 레시피'],
    naverQueries: ['AI 코딩 도구 추천'],
    nicheKeywords: ['cursor'],
    postTags: ['자동화', 'x'],
    max: 10,
  });
  const kws = c.map(x => x.keyword);
  eq(kws.includes('김치찌개 레시피'), false, '니치 무관 쿼리 배제');
  eq(kws.includes('x'), false, '2자 미만/니치 무관 태그 배제');
  eq(kws[0], 'ai 코딩 도구 추천', '우선순위: 네이버 타겟이 앞(상한 잘림 시 생존)');
  const cursorEntry = c.find(x => x.keyword === 'cursor');
  eq(!!cursorEntry, true, 'niche-config 소스 포함');

  eq(scoreOpportunity({ googlePosition: null, naverBest: null }), 1.5, '양쪽 미노출 = 최대 기회 1.5');
  eq(scoreOpportunity({ googlePosition: 2, naverBest: 1 }), 0, '양쪽 상위 노출 = 기회 0');
  eq(scoreOpportunity({ googlePosition: 15, naverBest: null }), 1.2, '구글 11위 밖 + 네이버 미노출');
  eq(finalScore(null, 1.5), null, '수요 측정불능 → 점수 null');
  eq(finalScore(2, 0.5), 2, 'demand×(0.5+opp)');

  eq(parseTags('---\ntitle: t\ntags: ["a b", "c"]\n---\n본문'), ['a b', 'c'], 'inline tags 파싱');
  eq(parseTags('---\ntags:\n  - a\n  - b\n---\n'), ['a', 'b'], '대시 목록 tags 파싱');
  eq(isNicheKeyword('퀀트 백테스팅'), true, '퀀트 니치 텀 포함');
  // 짧은 라틴 텀 경계 — 실측 오탐(gmail⊃ai)을 잠근다
  eq(isNicheKeyword('gmail'), false, 'gmail 은 니치 아님(ai 부분문자열 오탐 차단)');
  eq(isNicheKeyword('ai 코딩'), true, '"ai " 경계 매칭은 유지');
  eq(isNicheKeyword('openai'), true, 'openai 끝경계 ai 허용');
  eq(isNicheKeyword('chatgpt'), true, 'gpt 끝경계 허용');

  // 띄어쓰기 변형 dedup — "ai자동화"/"ai 자동화" 중복 진입 차단(실측)
  const dupTest = discoverCandidates({ gscQueries: ['ai 자동화'], naverQueries: [], nicheKeywords: [], postTags: ['ai자동화'], max: 10 });
  eq(dupTest.filter(x => x.keyword.replace(/\s+/g, '') === 'ai자동화').length, 1, '공백 변형은 1개만(우선순위 앞선 쪽)');

  // truncation 경계 실측 — max 를 실제로 넘겨서 우선순위 소스가 살아남는지(코드리뷰 지적: 주장만 있고 미검증이었음)
  const many = Array.from({ length: 10 }, (_, i) => `ai 태그 ${i}`);
  const cut = discoverCandidates({ gscQueries: many, naverQueries: ['ai 타겟 생존'], nicheKeywords: [], postTags: [], max: 3 });
  eq(cut.length, 3, 'max=3 상한에서 정확히 절단');
  eq(cut[0].keyword, 'ai 타겟 생존', '절단돼도 naver-target 이 생존(우선순위 실증)');

  // 마크다운 인젝션 방어 — GSC 유래 키워드의 파이프·개행이 표를 깨지 못한다(보안리뷰 지적)
  const evil = { keyword: 'ai | 주입\n# 탈출', sources: ['gsc'], demand: 1, opportunity: 1, score: 1.5, google: { impressions: 1, avg_position: null }, naver_best: null };
  const report = buildReport({ date: '2026-08-07', anchor: 'ai 코딩', rows: [evil], calls: 1, failures: 0, measured: 1 });
  const row = report.split('\n').find(l => l.includes('주입'));
  eq(/ai \\\| 주입 # 탈출/.test(row), true, '파이프 이스케이프 + 개행 제거로 셀 안에 갇힘');
  eq(report.includes('\n# 탈출'), false, '표 밖 마크다운 줄 주입 불가');
}

console.log('[3] mock e2e (격리 cwd)');
const sandbox = mkdtempSync(join(tmpdir(), 'kwd-'));
{
  // 최소 저장소 골격 — 스크립트가 상대경로로 읽는 것 전부
  mkdirSync(join(sandbox, 'config'), { recursive: true });
  mkdirSync(join(sandbox, 'state'), { recursive: true });
  mkdirSync(join(sandbox, 'published'), { recursive: true });
  cpSync('config/keyword-demand.json', join(sandbox, 'config/keyword-demand.json'));
  cpSync('config/naver-seo.json', join(sandbox, 'config/naver-seo.json'));
  writeFileSync(join(sandbox, 'config/pipeline.json'), JSON.stringify({
    topic_targeting: { niche_keywords: [{ keyword: 'claude code', weight: 3 }] },
  }));
  writeFileSync(join(sandbox, 'state/seo-metrics.jsonl'), JSON.stringify({
    date: '2026-08-01', dimension: 'query',
    rows: [{ key: 'ai 코딩 자동화', clicks: 1, impressions: 50, position: 14 }],
  }) + '\n');
  writeFileSync(join(sandbox, 'state/naver-rank.jsonl'), JSON.stringify({
    date: '2026-08-01', query: 'ai 코딩 자동화', ranks: [], best: null,
  }) + '\n');
  writeFileSync(join(sandbox, 'published/p1.md'), '---\ntitle: t\ntags: ["mcp 서버"]\n---\n본문');

  const out = execFileSync('node', [join(process.cwd(), 'scripts/seo/keyword-demand.mjs')], {
    cwd: sandbox, env: { ...process.env, RUN_MODE: 'mock' }, encoding: 'utf8',
  });
  eq(/"ok":true/.test(out), true, 'mock 실행 ok JSON');
  eq(existsSync(join(sandbox, 'state/keyword-demand-candidates.json')), true, 'candidates 생성');
  eq(existsSync(join(sandbox, 'state/keyword-demand.jsonl')), true, '이력 생성');
  const reports = existsSync(join(sandbox, 'docs/reports/seo'));
  eq(reports, true, '리포트 디렉토리 생성');

  const cand = JSON.parse(readFileSync(join(sandbox, 'state/keyword-demand-candidates.json'), 'utf8'));
  eq(cand.mock, true, 'mock 산출물에 mock 표시');
  // 🔴 오염 방지의 핵심 — 실제 적용 경로(allowMock=false)는 mock 파일을 거부한다
  eq(loadDemandCandidates({ path: join(sandbox, 'state/keyword-demand-candidates.json'), allowMock: false }), null,
     'mock candidates 를 실적용이 거부');
  const loaded = loadDemandCandidates({ path: join(sandbox, 'state/keyword-demand-candidates.json'), allowMock: true });
  eq(Array.isArray(loaded?.items), true, 'mock 허용 시 로드');
  // TTL 만료 거부
  const stale = { ...cand, mock: undefined, generated_at: new Date(Date.now() - 30 * 864e5).toISOString() };
  writeFileSync(join(sandbox, 'state/stale.json'), JSON.stringify(stale));
  eq(loadDemandCandidates({ path: join(sandbox, 'state/stale.json'), ttlDays: 21, allowMock: false }), null,
     'TTL(21일) 지난 candidates 거부');

  // 🔴 배치당 1회 소비 — 일일 잡의 7일 재소비로 상한 5가 20이 되는 것을 막는다(아키텍트 리뷰)
  const cpath = join(sandbox, 'state/keyword-demand-candidates.json');
  eq(markDemandConsumed(cpath), true, '소비 표시 기록');
  eq(loadDemandCandidates({ path: cpath, allowMock: true }), null, '소비된 candidates 는 재로드 거부');
}

console.log('[3b] 크리덴셜 있음 + 전 배치 실패 = rc 1 (거짓 green 방지)');
{
  const sb = mkdtempSync(join(tmpdir(), 'kwd3-'));
  mkdirSync(join(sb, 'config'), { recursive: true });
  mkdirSync(join(sb, 'state'), { recursive: true });
  cpSync('config/keyword-demand.json', join(sb, 'config/keyword-demand.json'));
  cpSync('config/naver-seo.json', join(sb, 'config/naver-seo.json'));
  writeFileSync(join(sb, 'config/pipeline.json'), JSON.stringify({
    topic_targeting: { niche_keywords: [{ keyword: 'claude code', weight: 3 }] },
  }));
  // 크리덴셜은 있으나(가짜) 실호출은 전부 실패한다 → 운영 장애로 취급, exit 1
  // 주 소스가 검색광고로 바뀌었으므로 가짜도 검색광고 키다(진짜 키는 .env 자동로드로
  // process.env 에 있을 수 있어 명시 덮어쓰기).
  const env = {
    ...process.env,
    NAVER_SEARCHAD_API_KEY: 'FAKE', NAVER_SEARCHAD_SECRET: 'RkFLRQ==', NAVER_SEARCHAD_CUSTOMER_ID: '1',
    NAVER_CLIENT_ID: 'FAKE', NAVER_CLIENT_SECRET: 'FAKE',
  };
  delete env.RUN_MODE;
  let rc = 0;
  try { execFileSync('node', [join(process.cwd(), 'scripts/seo/keyword-demand.mjs')], { cwd: sb, env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { rc = e.status ?? 1; }
  eq(rc, 1, '크리덴셜 있는데 전 배치 실패 → exit 1 (주간 크론 알림 발동)');
  eq(existsSync(join(sb, 'state/keyword-demand-candidates.json')), false, '실패 시 candidates 미기록');
}

console.log('[4] no-cred graceful (live 요청인데 크리덴셜 없음)');
{
  const env = { ...process.env };
  delete env.RUN_MODE; delete env.NAVER_CLIENT_ID; delete env.NAVER_CLIENT_SECRET;
  // 검색광고 키도 지워야 한다 — lib/config.mjs 가 import 시점에 .env 를 process.env 로
  // 채우므로(테스트 프로세스가 레포 루트에서 돌아서), 안 지우면 "크리덴셜 없음" 케이스가
  // 검색광고 경로로 새서 rc 1 이 된다.
  delete env.NAVER_SEARCHAD_API_KEY; delete env.NAVER_SEARCHAD_SECRET; delete env.NAVER_SEARCHAD_CUSTOMER_ID;
  const sandbox2 = mkdtempSync(join(tmpdir(), 'kwd2-'));
  mkdirSync(join(sandbox2, 'config'), { recursive: true });
  mkdirSync(join(sandbox2, 'state'), { recursive: true });
  cpSync('config/keyword-demand.json', join(sandbox2, 'config/keyword-demand.json'));
  cpSync('config/naver-seo.json', join(sandbox2, 'config/naver-seo.json'));
  writeFileSync(join(sandbox2, 'config/pipeline.json'), JSON.stringify({
    topic_targeting: { niche_keywords: [{ keyword: 'claude code', weight: 3 }] },
  }));
  let rc = 0;
  try { execFileSync('node', [join(process.cwd(), 'scripts/seo/keyword-demand.mjs')], { cwd: sandbox2, env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { rc = e.status ?? 1; }
  eq(rc, 0, '크리덴셜 없음 → exit 0 (비차단)');
  eq(existsSync(join(sandbox2, 'state/keyword-demand-candidates.json')), false, 'candidates 미생성');
}

console.log('[5] apply-targeting 병합 (buildNewKeywords)');
{
  const existing = [{ keyword: 'claude code', weight: 3 }];
  const tiers = [{ min_score: 1.0, weight: 3 }, { min_score: 0.3, weight: 2 }, { min_score: 0.0, weight: 1 }];
  const demand = [
    { keyword: 'mcp 서버 만들기', score: 1.4 },
    { keyword: 'claude code', score: 9 },          // 기존 → 무시(가중치는 GSC 신호의 몫)
    { keyword: 'ai 에이전트 구축', score: 0.4 },
    { keyword: '코딩 자동화 도구', score: 0.1 },
    { keyword: 'n4', score: 0.1 }, { keyword: 'n5', score: 0.1 }, { keyword: 'n6', score: 0.1 },
  ];
  const out = buildNewKeywords(existing, [], demand, { maxNew: 3, tiers });
  const find = (k) => out.find(x => x.keyword === k);
  eq(find('claude code')?.weight, 3, '기존 키워드 가중치 무손상');
  eq(find('mcp 서버 만들기')?.weight, 3, 'score≥1.0 → weight 3');
  eq(find('ai 에이전트 구축')?.weight, 2, 'score≥0.3 → weight 2');
  eq(find('코딩 자동화 도구')?.weight, 1, '하위 tier → weight 1');
  eq(out.filter(x => !existing.find(e => e.keyword === x.keyword)).length, 3, 'maxNew=3 상한 — n4~n6 미진입');

  const noDemand = buildNewKeywords(existing, [], [], { maxNew: 5, tiers });
  eq(noDemand.length, 1, 'demand 비면 기존만(무변경 경로 보존)');

  // tiers 를 오름차순으로 잘못 넣어도 정렬 방어로 같은 결과(설정 순서 실수 방어)
  const reversed = [...tiers].reverse();
  eq(buildNewKeywords(existing, [], [{ keyword: '역순 테스트', score: 1.4 }], { maxNew: 1, tiers: reversed })
       .find(x => x.keyword === '역순 테스트')?.weight, 3, 'tiers 순서 뒤집혀도 최고 구간 매칭');
}

console.log(`\n키워드 수요 스모크: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
