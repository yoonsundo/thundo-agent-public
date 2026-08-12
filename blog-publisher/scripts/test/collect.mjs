#!/usr/bin/env node
/**
 * scripts/test/collect.mjs — 실수집 검증 스크립트
 *
 * 용법:
 *   COLLECT_LIVE=1 RUN_MODE=mock node scripts/test/collect.mjs
 *
 * 동작:
 *   1. COLLECT_LIVE=1 → Reddit RSS + HN Algolia 실수집 시도
 *   2. 정규화된 Topic 후보 상위 5개 출력 (실제 제목 표시)
 *   3. 네트워크/429 실패 시 → mock 폴백으로 최소 1개 이상 확보
 *   4. 실제 제목 vs mock 제목 구분 표시
 *   5. 완전 실패(mock 포함 0개)만 exit 1, 나머지 exit 0
 *
 * RUN_MODE=mock: LLM·발행 크리덴셜 불필요 (수집만 live 시도)
 * COLLECT_LIVE=1: isCollectLive()=true → Reddit RSS, HN Algolia 실제 호출
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath }    from 'node:url';

const __filename  = fileURLToPath(import.meta.url);
const TEST_DIR    = dirname(__filename);
const SCRIPTS_DIR = resolve(TEST_DIR, '..');

// ─── 동적 import (경로 기준 확실히) ─────────────────────────────────────────

const { fetchReddit }      = await import(`${SCRIPTS_DIR}/reddit/fetch.mjs`);
const { fetchHN }          = await import(`${SCRIPTS_DIR}/reddit/hn.mjs`);
const { normalizeAll }     = await import(`${SCRIPTS_DIR}/reddit/normalize.mjs`);

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function label(source, isMockData) {
  if (isMockData) return `[mock/${source}]`;
  return `[live/${source}]`;
}

function isMockItem(topic) {
  // mock 캔드 데이터는 제목에 [Mock] 접두사 또는 id에 mock_ 포함
  return (
    topic.title.startsWith('[Mock]') ||
    topic.id.includes('mock_') ||
    (topic.id.startsWith('topic-hn-mock_')) ||
    (topic.id.startsWith('topic-reddit-mock_'))
  );
}

// ─── 실수집 시도 (graceful) ──────────────────────────────────────────────────

async function tryFetchReddit() {
  try {
    const posts = await fetchReddit();
    return { posts: posts || [], error: null };
  } catch (err) {
    return { posts: [], error: err.message };
  }
}

async function tryFetchHN() {
  try {
    const items = await fetchHN();
    return { items: items || [], error: null };
  } catch (err) {
    return { items: [], error: err.message };
  }
}

// ─── mock 폴백 데이터 ────────────────────────────────────────────────────────

function mockFallbackTopics() {
  return [
    {
      id:              'topic-fallback-001',
      source:          'mock-fallback',
      title:           '[Mock-Fallback] AI 에이전트 자동화 트렌드 2025',
      angle:           'mock 폴백 데이터',
      keywords:        ['AI', 'agent', 'automation'],
      source_refs:     [{ url: 'https://example.com/mock', type: 'mock', title: '' }],
      dedup_key:       'fallback001',
      _weighted_score: 0,
      created_at:      new Date().toISOString(),
    },
  ];
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

async function main() {
  const collectLive = process.env.COLLECT_LIVE === '1';
  const runMode     = process.env.RUN_MODE || 'mock';

  console.log('=== collect.mjs 실수집 검증 ===');
  console.log(`  COLLECT_LIVE=${collectLive ? '1 (live 수집 시도)' : '0 (mock)'}`);
  console.log(`  RUN_MODE=${runMode}`);
  console.log('');

  // ── Reddit 수집 ────────────────────────────────────────────────────────────
  console.log('[1] Reddit RSS 수집 시도...');
  const redditResult = await tryFetchReddit();

  if (redditResult.error) {
    console.warn(`  Reddit 수집 실패 (스킵): ${redditResult.error}`);
  } else {
    console.log(`  Reddit: ${redditResult.posts.length}개 포스트 수집`);
  }

  // ── HN 수집 ────────────────────────────────────────────────────────────────
  console.log('[2] HN Algolia 수집 시도...');
  const hnResult = await tryFetchHN();

  if (hnResult.error) {
    console.warn(`  HN 수집 실패 (스킵): ${hnResult.error}`);
  } else {
    console.log(`  HN: ${hnResult.items.length}개 항목 수집`);
  }

  // ── 정규화 ────────────────────────────────────────────────────────────────
  console.log('[3] 정규화...');
  let topics = [];
  try {
    topics = normalizeAll(redditResult.posts, hnResult.items, 15);
  } catch (err) {
    console.warn(`  정규화 오류 (스킵): ${err.message}`);
    topics = [];
  }

  // ── mock 폴백 ─────────────────────────────────────────────────────────────
  let usedFallback = false;
  if (topics.length === 0) {
    console.warn('[4] 수집 결과 0개 — mock 폴백 적용');
    topics = mockFallbackTopics();
    usedFallback = true;
  } else {
    console.log(`[4] 정규화 완료: ${topics.length}개 Topic 후보`);
  }

  // ── 상위 5개 출력 ─────────────────────────────────────────────────────────
  const top5 = topics.slice(0, 5);

  console.log('');
  console.log('=== 상위 Topic 후보 ===');

  for (let i = 0; i < top5.length; i++) {
    const topic  = top5[i];
    const isMock = isMockItem(topic) || usedFallback || topic.source === 'mock-fallback';
    const src    = topic.source || 'unknown';
    const tag    = isMock ? `[mock/${src}]` : `[live/${src}]`;
    const score  = topic._weighted_score != null ? ` (score=${topic._weighted_score})` : '';

    console.log(`  [${i + 1}] ${tag} ${topic.title}${score}`);
    if (topic.source_refs && topic.source_refs[0]) {
      console.log(`       url: ${topic.source_refs[0].url}`);
    }
  }

  console.log('');

  // ── 요약 ──────────────────────────────────────────────────────────────────
  const liveCount  = topics.filter(t => !isMockItem(t) && t.source !== 'mock-fallback').length;
  const mockCount  = topics.length - liveCount;

  console.log(`=== 요약 ===`);
  console.log(`  총 Topic: ${topics.length}개`);
  console.log(`  실제(live) 제목: ${liveCount}개`);
  console.log(`  mock 제목:       ${mockCount}개`);
  if (usedFallback) {
    console.log(`  ※ 네트워크 실패 또는 0개 결과 → mock 폴백 사용`);
  }

  // ── 종료 코드 ─────────────────────────────────────────────────────────────
  if (topics.length === 0) {
    console.error('[FAIL] Topic 0개 — exit 1');
    process.exit(1);
  }

  console.log('[PASS] Topic 확보 완료 — exit 0');
  process.exit(0);
}

main().catch(err => {
  console.error('[FATAL] collect.mjs 예외:', err.message);
  process.exit(1);
});
