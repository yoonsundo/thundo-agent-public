/**
 * audit/verify-chain.mjs — 감사 해시체인 무결성 검증
 * §D4: chain_hash 연속성 확인, seq 갭 탐지(삭제 탐지).
 * exit 0 = 체인 정상, exit 1 = 파손 탐지.
 */

import { existsSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';
import { paths, env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('audit/verify-chain');

// ─── 해시 유틸 ────────────────────────────────────────────────────────────────

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function computeChainHash(prevHash, seq, action, afterHash) {
  return sha256(`${prevHash}|${seq}|${action}|${afterHash}`);
}

function verifyHmac(chainHash, sig) {
  const key = env('AUDIT_SIGNING_KEY');
  if (!key || !sig) return null; // 서명 없으면 검증 스킵
  const expected = createHmac('sha256', key).update(chainHash, 'utf8').digest('hex');
  return expected === sig;
}

// ─── 검증 로직 ────────────────────────────────────────────────────────────────

/**
 * verifyChain(logPath?) → { ok, errors[], entries_checked }
 * 체인 무결성 검증:
 *   - seq 갭 → 삭제 탐지
 *   - chain_hash 불일치 → 변조 탐지
 *   - sig 검증(키 있을 때만)
 * 로그 파일이 없으면 ok=true (엣지케이스: 첫 런 전).
 */
export async function verifyChain(logPath) {
  const p = logPath || join(paths.audit, 'audit-log.jsonl');

  if (!existsSync(p)) {
    return { ok: true, errors: [], entries_checked: 0, note: '로그 파일 없음' };
  }

  const errors  = [];
  let prevHash  = 'GENESIS';
  let prevSeq   = 0;
  let count     = 0;

  let rl;
  try {
    rl = createInterface({
      input:     createReadStream(p, 'utf8'),
      crlfDelay: Infinity,
    });
  } catch (err) {
    return { ok: false, errors: [{ error: `스트림 열기 실패: ${err.message}`, type: 'IO_ERROR' }], entries_checked: 0 };
  }

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      errors.push({ line: count + 1, error: 'JSON 파싱 실패', raw: line.slice(0, 80), type: 'PARSE_ERROR' });
      continue;
    }

    count++;
    const { seq, action, after_hash, prev_hash, chain_hash, sig } = entry;

    // seq 갭 탐지 (삭제 감지)
    if (seq !== prevSeq + 1) {
      errors.push({
        seq,
        error: `seq 갭 탐지 — 예상: ${prevSeq + 1}, 실제: ${seq}`,
        type:  'SEQ_GAP',
      });
    }

    // prev_hash 일치 확인
    if (prev_hash !== prevHash) {
      errors.push({
        seq,
        error: `prev_hash 불일치 — 예상: ${prevHash.slice(0, 16)}…, 실제: ${(prev_hash || '').slice(0, 16)}…`,
        type:  'PREV_HASH_MISMATCH',
      });
    }

    // chain_hash 재계산 확인
    const expected = computeChainHash(prev_hash || prevHash, seq, action, after_hash || '');
    if (chain_hash !== expected) {
      errors.push({
        seq,
        error:    'chain_hash 불일치 — 위조 또는 변조 탐지',
        type:     'CHAIN_HASH_TAMPER',
        expected: expected.slice(0, 16) + '…',
        actual:   (chain_hash || '').slice(0, 16) + '…',
      });
    }

    // HMAC 서명 검증 (키 있을 때만)
    const sigOk = verifyHmac(chain_hash, sig);
    if (sigOk === false) {
      errors.push({
        seq,
        error: '서명 불일치 — sig 위조 탐지',
        type:  'SIG_TAMPER',
      });
    }

    prevHash = chain_hash;
    prevSeq  = seq;
  }

  return {
    ok:              errors.length === 0,
    errors,
    entries_checked: count,
    last_seq:        prevSeq,
    last_hash:       prevHash,
  };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('verify-chain.mjs')) {
  const logPath = process.argv[2];
  verifyChain(logPath).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      log.error(`체인 파손 탐지 — ${result.errors.length}개 오류`);
      process.exit(1);
    }
    log.info(`체인 정상 — ${result.entries_checked}개 항목 확인`);
  }).catch(err => {
    log.error('verify-chain 실행 실패', err);
    process.exit(2);
  });
}
