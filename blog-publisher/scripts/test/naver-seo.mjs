#!/usr/bin/env node
/**
 * naver-seo.mjs — 네이버 순위추적 루프 스모크 테스트
 *
 * 검증:
 *   1. mock 수집 → state jsonl 생성(레코드 ≥1), exit 0
 *   2. mock 리포트(dryrun) → 리포트 md 생성, exit 0
 *   3. no-credential graceful → 非mock+키없음 시 exit 0 & 미기록(cron 비차단 계약)
 *   4. buildSummary 단위 — 전일대비 델타·신규·이탈 판정 정확
 *
 * 격리: 임시 디렉토리 경로(NAVER_RANK_PATH·NAVER_REPORT_DIR)로 실제 state/리포트 미오염.
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSummary } from '../seo/naver-rank-report.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passN = 0, failN = 0;
const pass = (l) => { console.log(`  [PASS] ${l}`); passN++; };
const fail = (l, d = '') => { console.log(`  [FAIL] ${l}${d ? ' — ' + d : ''}`); failN++; };

async function run(script, env) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [join('scripts/seo', script)], {
      cwd: ROOT, env: { ...process.env, ...env }, timeout: 60000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'naver-seo-'));
  const rankPath = join(tmp, 'naver-rank.jsonl');
  const reportDir = join(tmp, 'reports');

  try {
    // 1. mock 수집
    const c = await run('naver-rank-collect.mjs', { RUN_MODE: 'mock', NAVER_RANK_PATH: rankPath });
    if (c.code === 0 && existsSync(rankPath)) {
      const recs = readFileSync(rankPath, 'utf8').trim().split('\n').filter(Boolean);
      recs.length >= 1 ? pass(`mock 수집: ${recs.length}레코드 생성`) : fail('mock 수집: 레코드 0');
    } else fail('mock 수집', `code=${c.code} jsonl=${existsSync(rankPath)} :: ${c.stderr.slice(0, 160)}`);

    // 2. mock 리포트(dryrun)
    const r = await run('naver-rank-report.mjs', {
      RUN_MODE: 'mock', NAVER_RANK_DRYRUN: '1', NAVER_RANK_PATH: rankPath, NAVER_REPORT_DIR: reportDir,
    });
    const mdFiles = existsSync(reportDir) ? readdirSync(reportDir).filter(f => f.endsWith('.md')) : [];
    if (r.code === 0 && mdFiles.length >= 1) pass(`mock 리포트: ${mdFiles[0]} 생성`);
    else fail('mock 리포트', `code=${r.code} mds=${mdFiles.length} :: ${r.stderr.slice(0, 160)}`);

    // 3. no-credential graceful (非mock + 키 제거)
    const g = await run('naver-rank-collect.mjs', {
      RUN_MODE: '', NAVER_CLIENT_ID: '', NAVER_CLIENT_SECRET: '',
      NAVER_APIHUB_CLIENT_ID: '', NAVER_APIHUB_CLIENT_SECRET: '',
      NAVER_RANK_PATH: join(tmp, 'should-not-exist.jsonl'),
    });
    if (g.code === 0 && !existsSync(join(tmp, 'should-not-exist.jsonl'))) pass('no-credential graceful: exit0 & 미기록');
    else fail('no-credential graceful', `code=${g.code} wrote=${existsSync(join(tmp, 'should-not-exist.jsonl'))}`);

    // 4. buildSummary 단위
    const map = new Map([
      ['2026-07-14|A', { date: '2026-07-14', query: 'A', best: { rank: 5, url: 'u' } }],
      ['2026-07-15|A', { date: '2026-07-15', query: 'A', best: { rank: 2, url: 'u' } }], // 상승 +3
      ['2026-07-14|B', { date: '2026-07-14', query: 'B', best: { rank: 3, url: 'u' } }],
      ['2026-07-15|B', { date: '2026-07-15', query: 'B', best: null }],                   // 이탈
      ['2026-07-15|C', { date: '2026-07-15', query: 'C', best: { rank: 8, url: 'u' } }],   // 신규
    ]);
    const s = buildSummary(map);
    const ok = s.today === '2026-07-15' && s.prev === '2026-07-14'
      && s.counts.up === 1 && s.counts.dropped === 1 && s.counts.new === 1;
    ok ? pass(`buildSummary: up=${s.counts.up} dropped=${s.counts.dropped} new=${s.counts.new}`)
       : fail('buildSummary', JSON.stringify(s.counts));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n네이버 SEO 스모크: ${passN} pass / ${failN} fail`);
  process.exit(failN === 0 ? 0 : 1);
}

main().catch(e => { console.error(`[naver-seo test] 치명: ${e.message}`); process.exit(1); });
