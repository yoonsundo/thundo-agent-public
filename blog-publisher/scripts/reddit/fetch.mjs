/**
 * reddit/fetch.mjs — Reddit RSS(Atom) 수집
 * §C3 규격 준수:
 *   live: 공개 RSS 피드(.rss), 브라우저 UA, 서브레딧 간 2.5초 간격, 429 지수백오프
 *   mock: config/subreddits.json 기반 캔드 3~5개 반환
 * 출력: runs/<date>/reddit/raw-<date>.json
 * 중복제거: reddit-seen.json (키=reddit:<sub>:<id>)
 * 엣지케이스: subreddits.json 없음, 빈 결과, 네트워크 실패 — graceful 처리.
 *
 * NOTE: 데이터센터 IP에서 Reddit *.json 엔드포인트는 HTTP 403 차단됨.
 *       *.rss (Atom 피드)는 HTTP 200 정상 작동 — 이 파일은 RSS만 사용.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isMock, isCollectLive, loadSubreddits, paths, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('reddit/fetch');

// ─── 경로 헬퍼 ────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function runsDir(date = todayStr()) {
  return join(paths.runs, date, 'reddit');
}

function seenPath() {
  return join(paths.state, 'reddit-seen.json');
}

// ─── seen-set 로드/저장 ───────────────────────────────────────────────────────

function loadSeen() {
  const p = seenPath();
  if (!existsSync(p)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return new Set(Array.isArray(obj) ? obj : Object.keys(obj));
  } catch (err) {
    log.warn('reddit-seen.json 파싱 실패 — 빈 집합으로 시작', err);
    return new Set();
  }
}

function saveSeen(seen) {
  const p   = seenPath();
  const dir = paths.state;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(p, JSON.stringify([...seen], null, 2), 'utf8');
  } catch (err) {
    log.error('reddit-seen.json 저장 실패', err);
  }
}

// ─── 슬립 & 지수 백오프 ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * fetchWithBackoff — RSS XML을 text로 반환.
 * 429 시 지수백오프, 네트워크 오류 시 재시도.
 */
async function fetchWithBackoff(url, ua, config) {
  const { base_ms = 2000, max_ms = 60000, retries = 3 } = config.backoff || {};
  let delay = base_ms;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept':     'application/rss+xml, application/atom+xml, text/xml, */*',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === retries) throw err;
      log.warn(`fetch 오류 (시도 ${attempt + 1}/${retries + 1}) — ${err.message}`);
      await sleep(Math.min(delay, max_ms));
      delay *= 2;
      continue;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) * 1000;
      const wait = Math.min(Math.max(retryAfter, delay), max_ms);
      if (attempt === retries) throw new Error(`Reddit 429 — 재시도 초과 (${url})`);
      log.warn(`Reddit 429 — ${wait}ms 후 재시도`);
      await sleep(wait);
      delay = Math.min(delay * 2, max_ms);
      continue;
    }

    if (!res.ok) throw new Error(`Reddit HTTP ${res.status} — ${url}`);

    return res.text();
  }
}

// ─── Atom/RSS XML 간이 파서 ──────────────────────────────────────────────────
// 외부 라이브러리 없이 정규식으로 <entry> 블록 파싱.

/**
 * 태그 내용 추출. CDATA 포함.
 */
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

/**
 * 속성 값 추출: <tag attr="value" ...>
 */
function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

/**
 * Reddit Atom 피드의 <entry> 요소들 파싱.
 * 반환: { id, title, link, author, updated, content }[]
 */
function parseAtomEntries(xml) {
  // <entry>...</entry> 블록 추출
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  const entries = [];
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];

    // link href 추출: <link rel="alternate" href="..." .../>
    const linkHrefRe = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i;
    const linkM = block.match(linkHrefRe);
    const link = linkM ? linkM[1] : '';

    // id 추출 (t3_ prefix 이후 포스트 ID)
    const rawId = extractTag(block, 'id');
    // Reddit atom id 형식: "t3_<postid>" 또는 URL 형태
    const postIdM = rawId.match(/t3_([a-z0-9]+)/i) || link.match(/comments\/([a-z0-9]+)\//i);
    const postId = postIdM ? postIdM[1] : rawId.slice(-8) || String(Math.random()).slice(2, 10);

    const title   = extractTag(block, 'title');
    const author  = extractTag(block, 'name') || extractTag(block, 'author');
    const updated = extractTag(block, 'updated') || extractTag(block, 'published');
    const content = extractTag(block, 'content') || extractTag(block, 'summary');

    // 점수·댓글 수는 Atom에 없음 — content HTML에서 추출 시도
    let score       = 0;
    let num_comments = 0;
    const scoreM   = content.match(/(\d+)\s*point/i);
    const commentsM = content.match(/(\d+)\s*comment/i);
    if (scoreM)    score        = parseInt(scoreM[1], 10);
    if (commentsM) num_comments = parseInt(commentsM[1], 10);

    if (!title) continue; // 제목 없는 항목 스킵

    entries.push({
      id:           postId,
      title:        title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      url:          link,
      permalink:    link.replace('https://www.reddit.com', ''),
      author:       author.replace(/&amp;/g, '&'),
      updated,
      content,
      score,
      num_comments,
      selftext:     '',
      created_utc:  updated ? Math.floor(new Date(updated).getTime() / 1000) : Math.floor(Date.now() / 1000),
    });
  }
  return entries;
}

// ─── mock 캔드 데이터 ─────────────────────────────────────────────────────────

function mockPosts(subreddit, count = 4) {
  const templates = [
    {
      id: `mock_${subreddit}_001`,
      title: `[Mock] Claude Code로 반복 작업 자동화한 후기`,
      score: 1523,
      num_comments: 87,
      url: `https://www.reddit.com/r/${subreddit}/comments/mock001/`,
      permalink: `/r/${subreddit}/comments/mock001/`,
      selftext: '',
      author: 'mock_user_1',
      created_utc: Math.floor(Date.now() / 1000) - 3600,
    },
    {
      id: `mock_${subreddit}_002`,
      title: `[Mock] GPT-4o vs Claude 3.5 — 코딩 태스크 실전 비교`,
      score: 982,
      num_comments: 134,
      url: `https://www.reddit.com/r/${subreddit}/comments/mock002/`,
      permalink: `/r/${subreddit}/comments/mock002/`,
      selftext: '',
      author: 'mock_user_2',
      created_utc: Math.floor(Date.now() / 1000) - 7200,
    },
    {
      id: `mock_${subreddit}_003`,
      title: `[Mock] n8n + AI API로 뉴스 요약 자동화 워크플로우`,
      score: 756,
      num_comments: 62,
      url: `https://www.reddit.com/r/${subreddit}/comments/mock003/`,
      permalink: `/r/${subreddit}/comments/mock003/`,
      selftext: '',
      author: 'mock_user_3',
      created_utc: Math.floor(Date.now() / 1000) - 10800,
    },
    {
      id: `mock_${subreddit}_004`,
      title: `[Mock] Cursor IDE 6개월 사용 — 생산성 변화 정직한 후기`,
      score: 634,
      num_comments: 45,
      url: `https://www.reddit.com/r/${subreddit}/comments/mock004/`,
      permalink: `/r/${subreddit}/comments/mock004/`,
      selftext: '',
      author: 'mock_user_4',
      created_utc: Math.floor(Date.now() / 1000) - 14400,
    },
    {
      id: `mock_${subreddit}_005`,
      title: `[Mock] Obsidian + AI 플러그인 조합으로 제텔카스텐 구축기`,
      score: 498,
      num_comments: 38,
      url: `https://www.reddit.com/r/${subreddit}/comments/mock005/`,
      permalink: `/r/${subreddit}/comments/mock005/`,
      selftext: '',
      author: 'mock_user_5',
      created_utc: Math.floor(Date.now() / 1000) - 18000,
    },
  ];
  return templates.slice(0, Math.max(1, count));
}

// ─── 메인 fetch ───────────────────────────────────────────────────────────────

/**
 * fetchReddit() → raw posts 배열 (seen 필터 적용)
 * live 모드: RSS Atom 피드 사용 (*.rss), 서브레딧 간 2.5초 간격.
 * mock 모드: 캔드 데이터 반환.
 * runs/<date>/reddit/raw-<date>.json 에 저장.
 */
export async function fetchReddit() {
  let config;
  try {
    config = loadSubreddits();
  } catch (err) {
    log.error('subreddits.json 로드 실패', err);
    return [];
  }

  if (!config || !Array.isArray(config.subreddits) || config.subreddits.length === 0) {
    log.warn('subreddits.json에 subreddit이 없음 — 빈 결과 반환');
    return [];
  }

  const date   = todayStr();
  const outDir = runsDir(date);

  if (!existsSync(outDir)) {
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (err) {
      log.error('reddit 출력 디렉터리 생성 실패', err);
      return [];
    }
  }

  const seen     = loadSeen();
  const allPosts = [];

  if (!isCollectLive()) {
    // mock: 각 subreddit마다 캔드 데이터
    for (const sub of config.subreddits) {
      const posts = mockPosts(sub.name, 3 + Math.floor(Math.random() * 3));
      for (const p of posts) {
        const key = `reddit:${sub.name}:${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allPosts.push({ ...p, _subreddit: sub.name, _key: key });
      }
    }
    log.info(`mock 모드 — ${allPosts.length}개 캔드 포스트 (COLLECT_LIVE=1 로 live 수집 가능)`);
  } else {
    // live: RSS Atom 피드 사용 (*.json은 데이터센터 IP에서 403 차단)
    // 브라우저 UA 필수 (봇 차단 우회)
    const ua = env('REDDIT_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    for (let i = 0; i < config.subreddits.length; i++) {
      const sub = config.subreddits[i];

      // 첫 번째가 아니면 2.5초 간격 (Rate-limit 예방)
      if (i > 0) {
        log.info(`r/${sub.name} 전 2.5초 대기 (rate-limit 예방)…`);
        await sleep(2500);
      }

      // RSS URL 구성: /r/<sub>/<hot|top>/.rss
      const endpoint = sub.endpoint || 'hot';
      const timeParam = sub.t ? `?t=${sub.t}&limit=${sub.limit || 25}` : `?limit=${sub.limit || 25}`;
      const url = `https://www.reddit.com/r/${sub.name}/${endpoint}/.rss${timeParam}`;

      try {
        log.info(`r/${sub.name} RSS 수집: ${url}`);
        const xml = await fetchWithBackoff(url, ua, config);

        if (!xml || xml.trim().length === 0) {
          log.warn(`r/${sub.name}: 빈 RSS 응답`);
          continue;
        }

        const entries = parseAtomEntries(xml);
        if (entries.length === 0) {
          log.warn(`r/${sub.name}: 파싱된 항목 0개 (XML 구조 확인 필요)`);
          continue;
        }

        log.info(`r/${sub.name}: ${entries.length}개 항목 파싱`);

        for (const entry of entries) {
          const key = `reddit:${sub.name}:${entry.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allPosts.push({ ...entry, _subreddit: sub.name, _key: key });
        }

      } catch (err) {
        log.error(`r/${sub.name} RSS fetch 실패 — 해당 subreddit 스킵: ${err.message}`);
        // graceful: 다음 subreddit 계속
      }
    }
    log.info(`live 모드 — ${allPosts.length}개 신규 포스트`);
  }

  if (allPosts.length === 0) {
    log.warn('수집된 포스트 없음 — seed-topics.md 백필 필요');
  }

  // seen 저장
  saveSeen(seen);

  // 결과 저장
  const outPath = join(outDir, `raw-${date}.json`);
  const payload = {
    fetched_at:   new Date().toISOString(),
    mode:         isMock() ? 'mock' : 'live',
    collect_mode: isCollectLive() ? 'live' : 'mock',
    count:        allPosts.length,
    posts:        allPosts,
  };
  try {
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    log.info(`저장: ${outPath}`);
  } catch (err) {
    log.error('reddit raw JSON 저장 실패', err);
  }

  return allPosts;
}

// CLI 직접 실행
if (process.argv[1] && process.argv[1].endsWith('fetch.mjs')) {
  fetchReddit().then(posts => {
    console.log(`완료: ${posts.length}개`);
    if (posts.length > 0) {
      console.log('\n수집된 포스트 샘플 (상위 5개):');
      posts.slice(0, 5).forEach((p, i) => {
        console.log(`  [${i + 1}] [r/${p._subreddit}] ${p.title}`);
      });
    }
  }).catch(err => {
    console.error('[reddit/fetch] 치명적 오류:', err.message);
    process.exit(1);
  });
}
