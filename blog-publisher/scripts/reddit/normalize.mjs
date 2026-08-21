/**
 * reddit/normalize.mjs — raw Reddit RSS 항목 + HN 항목 → Topic 후보
 * score + comments 가중 상위, dedup_key 16자, keywords 추출.
 * LLM 호출 없음. 변형·분석은 작가 책임.
 *
 * 지원 소스:
 *   - reddit-rss: fetchReddit() 반환 항목 (source="reddit")
 *   - hn:         fetchHN()     반환 항목 (source="hn")
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/config.mjs';

import { isMainModule } from '../lib/main-module.mjs';
// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** §A2 dedup_key: sha256(normalize(title)+"|"+sort(keywords))[:16] */
function makeDedupKey(title, keywords) {
  const norm = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const kw   = [...keywords].sort().join(',');
  return sha256hex(`${norm}|${kw}`).slice(0, 16);
}

/** 가중 점수: score * 1 + comments * 3 (댓글 가중치 높임) */
function weightedScore(item) {
  const score    = Number(item.score || item.points || 0);
  const comments = Number(item.num_comments || 0);
  return score + comments * 3;
}

/** 제목에서 간단 키워드 추출 (영단어 4자 이상, 한국어 2어절 이상) */
function extractKeywords(title) {
  const words = title.replace(/[\[\](){}<>\/\\,.:;!?'"]/g, ' ').split(/\s+/);
  const kw = new Set();
  for (const w of words) {
    if (/[a-zA-Z]{4,}/.test(w)) kw.add(w.toLowerCase());
    if (/[가-힣]{2,}/.test(w))  kw.add(w);
  }
  return [...kw].slice(0, 6);
}

// ─── Reddit RSS 항목 → Topic ──────────────────────────────────────────────────

function normalizeRedditItem(post) {
  const title    = (post.title || '').trim();
  const keywords = extractKeywords(title);
  const subName  = post._subreddit || post.subreddit || 'unknown';
  const postId   = post.id || uid();
  const postUrl  = post.url || `https://www.reddit.com${post.permalink || ''}`;

  const source_refs = [
    {
      url:   post.permalink
        ? `https://www.reddit.com${post.permalink}`
        : `https://www.reddit.com/r/${subName}/comments/${postId}/`,
      type:  'reddit',
      title: title,
    },
  ];

  // 외부 링크 포스트면 해당 URL도 추가
  if (postUrl && !postUrl.includes('reddit.com')) {
    source_refs.push({ url: postUrl, type: 'external', title: title });
  }

  return {
    id:          `topic-reddit-${postId}`,
    source:      'reddit',
    collector:   'magpie',
    title:       title,
    angle:       `Reddit r/${subName} 인기글 기반 소재 — 독자적 분석·관점 필요`,
    keywords,
    source_refs,
    dedup_key:   makeDedupKey(title, keywords),
    reddit_meta: {
      subreddit:    subName,
      post_id:      postId,
      score:        post.score || 0,
      num_comments: post.num_comments || 0,
      author:       post.author || '',
      created_utc:  post.created_utc || 0,
      selftext_len: (post.selftext || '').length,
    },
    _weighted_score: weightedScore(post),
    created_at: new Date().toISOString(),
  };
}

// ─── HN 항목 → Topic ──────────────────────────────────────────────────────────

function normalizeHnItem(item) {
  const title    = (item.title || '').trim();
  const keywords = extractKeywords(title);
  const hnUrl    = item.url || `https://news.ycombinator.com/item?id=${item.objectID}`;
  const hnThread = `https://news.ycombinator.com/item?id=${item.objectID}`;

  const source_refs = [
    {
      url:   hnThread,
      type:  'hn',
      title: title,
    },
  ];

  // 외부 기사 URL 있으면 추가
  if (item.url && !item.url.includes('ycombinator.com')) {
    source_refs.push({ url: item.url, type: 'external', title: title });
  }

  return {
    id:          `topic-hn-${item.objectID || uid()}`,
    source:      'hn',
    collector:   'magpie',
    title:       title,
    angle:       `HN 트렌딩 [${item._query || 'AI'}] — 기술적 관점·실무 적용 분석 필요`,
    keywords,
    source_refs,
    dedup_key:   makeDedupKey(title, keywords),
    hn_meta: {
      objectID:     item.objectID || '',
      points:       item.points   || 0,
      num_comments: item.num_comments || 0,
      author:       item.author   || '',
      created_at:   item.created_at || '',
      query:        item._query   || '',
    },
    _weighted_score: weightedScore(item),
    created_at: new Date().toISOString(),
  };
}

// ─── 정규화 ───────────────────────────────────────────────────────────────────

/**
 * normalizePosts(posts, topN) → Topic[]
 * Reddit RSS 항목 → Topic (§A2 스키마, source=reddit).
 *
 * NOTE: Reddit Atom RSS 피드는 score/num_comments를 노출하지 않음.
 * 피드 순서(hot/top 랭킹 순)가 이미 Reddit의 정렬 기준이므로
 * score=0인 경우 피드 인덱스(낮을수록 상위)를 역가중으로 사용.
 */
export function normalizePosts(posts, topN = 10) {
  if (!Array.isArray(posts) || posts.length === 0) return [];

  const filtered = posts.filter(p => p.title && p.title.trim().length > 5);

  // score가 있으면 가중점수 정렬, 모두 0이면 피드 순서(인덱스) 유지
  const allZero = filtered.every(p => weightedScore(p) === 0);
  const sorted = allZero
    ? filtered.slice(0, topN)  // 피드 순서 = Reddit 자체 hot/top 랭킹
    : [...filtered].sort((a, b) => weightedScore(b) - weightedScore(a)).slice(0, topN);

  // _feed_rank 부여 (낮을수록 상위)
  return sorted.map((post, idx) => {
    const topic = normalizeRedditItem(post);
    topic._feed_rank = idx;
    // RSS에서 score=0이면 피드 순위 기반 가중점수 추정 (상위일수록 높게)
    if (topic._weighted_score === 0) {
      topic._weighted_score = Math.max(0, topN - idx);
    }
    return topic;
  });
}

/**
 * normalizeHnItems(items, topN) → Topic[]
 * HN Algolia 항목 → Topic (§A2 스키마, source=hn).
 */
export function normalizeHnItems(items, topN = 10) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const sorted = [...items]
    .filter(i => i.title && i.title.trim().length > 5)
    .sort((a, b) => weightedScore(b) - weightedScore(a))
    .slice(0, topN);

  return sorted.map(normalizeHnItem);
}

/**
 * normalizeAll(redditPosts, hnItems, topN) → Topic[]
 * Reddit + HN 합산 → 가중점수 정렬 상위 topN.
 * dedup_key 기준 중복 제거(같은 기사가 양쪽에 나오면 먼저 나온 것 유지).
 */
export function normalizeAll(redditPosts, hnItems, topN = 15) {
  const redditTopics = normalizePosts(redditPosts, topN);
  const hnTopics     = normalizeHnItems(hnItems, topN);

  // 합산 후 dedup_key 중복 제거
  const seenKeys = new Set();
  const combined = [];
  for (const topic of [...redditTopics, ...hnTopics]) {
    if (seenKeys.has(topic.dedup_key)) continue;
    seenKeys.add(topic.dedup_key);
    combined.push(topic);
  }

  // 가중점수 재정렬 후 topN
  return combined
    .sort((a, b) => (b._weighted_score || 0) - (a._weighted_score || 0))
    .slice(0, topN);
}

/**
 * normalizeFile(rawJsonPath) → Topic[]
 * runs/<date>/reddit/raw-<date>.json 파일에서 직접 로드 (reddit 항목만).
 */
export function normalizeFile(rawJsonPath) {
  if (!existsSync(rawJsonPath)) {
    throw new Error(`파일 없음: ${rawJsonPath}`);
  }
  const raw   = JSON.parse(readFileSync(rawJsonPath, 'utf8'));
  const posts = raw.posts || raw;
  return normalizePosts(Array.isArray(posts) ? posts : []);
}

// CLI
if (isMainModule(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('사용법: node normalize.mjs <raw-json-path>');
    process.exit(1);
  }
  const topics = normalizeFile(inputPath);
  console.log(JSON.stringify(topics, null, 2));
}
