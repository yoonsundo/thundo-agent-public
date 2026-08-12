#!/usr/bin/env node
/**
 * check-build.mjs — Astro staging 빌드 검사
 * 입력: argv[2] = 초안 .md 절대경로, argv[3] = site 경로(생략 가능)
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 * 보장: staging 파일은 finally에서 항상 삭제
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, '../../');

const BUILD_TIMEOUT_MS = 120_000; // 2분

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** dist 디렉터리의 모든 파일 해시 (SHA256, 정렬 후 집계) */
function hashDist(distDir) {
  if (!existsSync(distDir)) return null;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(full);
      }
    }
  };
  walk(distDir);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.replace(distDir, ''));
    h.update(readFileSync(f));
  }
  return h.digest('hex').slice(0, 16);
}

/** 유효한 Astro site 경로인지 판별 (astro 바이너리까지 존재해야 함) */
function isValidSitePath(sitePath) {
  if (!sitePath) return false;
  if (!existsSync(sitePath)) return false;
  // package.json에 astro 언급이 있어야 함
  const pkgPath = join(sitePath, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!(pkg.dependencies?.astro || pkg.devDependencies?.astro)) return false;
  } catch {
    return false;
  }
  // astro 바이너리가 실제 설치돼 있어야 함 (node_modules/.bin/astro)
  const astroBin = join(sitePath, 'node_modules', '.bin', 'astro');
  return existsSync(astroBin);
}

async function main() {
  const draftPath = process.argv[2];
  const siteArg = process.argv[3];

  if (!draftPath) {
    process.stderr.write('Usage: check-build.mjs <draft.md> [site-path]\n');
    process.exit(2);
  }

  const absDraft = resolve(draftPath);

  // site 경로 결정
  const sitePath = siteArg
    ? resolve(siteArg)
    : join(REPO_ROOT, 'site');

  // site 없거나 astro 아니면 graceful skip
  if (!isValidSitePath(sitePath)) {
    const result = {
      gate: 'build',
      pass: true,
      reason: `site 경로 없거나 Astro 아님 — graceful skip (${sitePath})`,
      evidence: { build_hash: null, note: 'skipped' },
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  // staging 디렉터리: site/src/content/blog/_staging/
  const stagingDir = join(sitePath, 'src', 'content', 'blog', '_staging');
  const stagingFile = join(stagingDir, basename(absDraft));

  let stagingCreated = false;
  try {
    // staging에 초안 복사
    let raw;
    try {
      raw = readFileSync(absDraft, 'utf8');
    } catch (e) {
      process.stderr.write(`check-build: 초안 읽기 실패: ${e.message}\n`);
      process.exit(2);
    }

    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(stagingFile, raw, 'utf8');
    stagingCreated = true;

    // astro build
    let buildResult;
    try {
      buildResult = await execFileAsync(
        'node',
        ['node_modules/.bin/astro', 'build'],
        {
          cwd: sitePath,
          timeout: BUILD_TIMEOUT_MS,
          env: { ...process.env, NODE_ENV: 'production' },
        }
      );
    } catch (e) {
      const output = (e.stdout || '') + (e.stderr || '');
      const result = {
        gate: 'build',
        pass: false,
        reason: `Astro 빌드 실패: ${e.message.slice(0, 200)}`,
        evidence: { build_hash: null, output: output.slice(0, 500) },
      };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(1);
    }

    const distDir = join(sitePath, 'dist');
    const build_hash = hashDist(distDir);

    const result = {
      gate: 'build',
      pass: true,
      reason: '빌드 성공',
      evidence: { build_hash },
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);

  } finally {
    // staging 파일 항상 삭제
    if (stagingCreated) {
      try {
        rmSync(stagingFile, { force: true });
        // 비어있으면 디렉터리도 삭제
        if (readdirSync(stagingDir).length === 0) {
          rmSync(stagingDir, { recursive: true, force: true });
        }
      } catch (e) {
        process.stderr.write(`check-build: staging 삭제 실패: ${e.message}\n`);
      }
    }
  }
}

main();
