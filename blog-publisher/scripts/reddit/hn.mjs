/**
 * reddit/hn.mjs — Hacker News Algolia API 수집
 * 엔드포인트: https://hn.algolia.com/api/v1/search_by_date?query=<q>&tags=story&hitsPerPage=N
 * 무인증, GET only, 공개 API.
 *
 * 니치 키워드(config/niche.json 기반): "AI agent", "Claude", "LLM automation", "AI productivity"
 * 출력: HnItem[] — { title, url, points, num_comments, objectID, _source: 'hn', _query }
 */

import { makeLogger } from '../lib/log.mjs';
import { isCollectLive } from '../lib/config.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('reddit/hn');

// ─── 니치 검색 쿼리 목록 ──────────────────────────────────────────────────────
// config/niche.json 의 categories와 연계: AI 도구, 자동화, 에이전트·LLM
const HN_QUERIES = [
  'AI agent',
  'Claude LLM',
  'LLM automation',
];

const HN_HITS_PER_PAGE = 15;
const HN_BASE_URL = 'https://hn.algolia.com/api/v1/search_by_date';

// ─── 슬립 ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── mock 캔드 데이터 ─────────────────────────────────────────────────────────

function mockHnItems() {
  return [
    {
      title:        '[Mock] Building an AI agent that writes blog posts automatically',
      url:          'https://example.com/ai-agent-blog',
      points:       342,
      num_comments: 87,
      objectID:     'mock_hn_001',
      _source:      'hn',
      _query:       'AI agent',
    },
    {
      title:        '[Mock] Claude vs GPT-4: a practical comparison for developers',
      url:          'https://example.com/claude-vs-gpt4',
      points:       289,
      num_comments: 134,
      objectID:     'mock_hn_002',
      _source:      'hn',
      _query:       'Claude LLM',
    },
    {
      title:        '[Mock] How I automated my entire content pipeline with LLMs',
      url:          'https://example.com/llm-content-pipeline',
      points:       198,
      num_comments: 62,
      objectID:     'mock_hn_003',
      _source:      'hn',
      _query:       'LLM automation',
    },
  ];
}

// ─── 단일 쿼리 fetch ──────────────────────────────────────────────────────────

async function fetchHnQuery(query) {
  const url = `${HN_BASE_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${HN_HITS_PER_PAGE}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`HN fetch 네트워크 오류 (query="${query}"): ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(`HN HTTP ${res.status} (query="${query}")`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`HN JSON 파싱 실패 (query="${query}"): ${err.message}`);
  }

  const hits = json.hits || [];
  return hits
    .filter(h => h.title && h.title.trim().length > 5)
    .map(h => ({
      title:        h.title.trim(),
      url:          h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points:       h.points || 0,
      num_comments: h.num_comments || 0,
      objectID:     h.objectID,
      created_at:   h.created_at,
      author:       h.author || '',
      _source:      'hn',
      _query:       query,
    }));
}

// ─── 메인 수집 ────────────────────────────────────────────────────────────────

/**
 * fetchHN() → HnItem[]
 * 여러 쿼리를 순차 호출(쿼리 간 500ms), 결과 합산 후 objectID 기준 dedup.
 * 네트워크 실패 시 graceful(해당 쿼리 스킵, 나머지 진행).
 */
export async function fetchHN() {
  if (!isCollectLive()) {
    const items = mockHnItems();
    log.info(`mock 모드 — HN ${items.length}개 캔드 항목`);
    return items;
  }

  const allItems = [];
  const seenIds  = new Set();

  for (let i = 0; i < HN_QUERIES.length; i++) {
    const query = HN_QUERIES[i];
    if (i > 0) await sleep(500); // 쿼리 간 짧은 간격

    try {
      log.info(`HN 수집: query="${query}"`);
      const items = await fetchHnQuery(query);
      log.info(`HN query="${query}": ${items.length}개 히트`);

      for (const item of items) {
        if (seenIds.has(item.objectID)) continue; // 쿼리 간 중복 제거
        seenIds.add(item.objectID);
        allItems.push(item);
      }
    } catch (err) {
      log.error(`HN query="${query}" 실패 — 스킵: ${err.message}`);
      // graceful: 다음 쿼리 계속
    }
  }

  log.info(`HN 수집 완료 — 총 ${allItems.length}개 (dedup 후)`);
  return allItems;
}

// CLI 직접 실행
if (isMainModule(import.meta.url)) {
  fetchHN().then(items => {
    console.log(`\nHN 수집 완료: ${items.length}개`);
    items.slice(0, 5).forEach((item, i) => {
      console.log(`  [${i + 1}] [query: ${item._query}] ${item.title}`);
      console.log(`       points=${item.points} comments=${item.num_comments} url=${item.url}`);
    });
  }).catch(err => {
    console.error('[hn] 치명적 오류:', err.message);
    process.exit(1);
  });
}
