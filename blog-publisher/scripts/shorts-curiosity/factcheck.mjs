#!/usr/bin/env node
/**
 * shorts-curiosity/factcheck.mjs — 선정 아이템 가벼운 사실 안전망
 *
 * "설마 진짜?"가 힘을 가지려면 실제 사실이어야 한다. 학술 검증 아닌 가벼운 플로시빌리티 +
 * 기본 근거 확인. verdict=ok 만 제작 진행, doubtful/false 는 스킵(백로그 보류).
 * 계약: 함수 factCheck(item) → { verdict, note, source, needs_correction, corrected_subject,
 *       corrected_reveal }. CLI: stdout JSON.
 *
 * US-010(2026-07-30 실사고): 구계약은 `{verdict,note,source}` 뿐이라 **"사실이지만 세부 수치가
 * 틀렸다"가 통째로 새어나갔다.** 실제로 10시 슬롯이 이런 판정을 받고도 그대로 발행됐다:
 *   verdict=ok, note="…제목의 '13억 원'은 자릿수 오류(약 1조 원 이상이 맞음)이니 대본에서
 *   반드시 수정할 것."
 * 팩트체커가 "반드시 수정"을 명시했는데 verdict 가 ok 라서 기계가 못 읽고 지나쳤다. 그래서
 * ① 정정 요구를 **구조화 필드**(needs_correction/corrected_*)로 받고 ② 정정본을 제목·대본까지
 * 흘려보내고 ③ 정정을 적용할 수 없으면 **발행하지 않고 보류**한다. 애매하면 내보내지 않는다 —
 * "설마 진짜?" 채널에서 사실 정확성은 부가기능이 아니라 상품 그 자체다.
 */
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, callClaude, extractJson, isMainModule, loadAgentBrief } from './lib.mjs';
import '../lib/force-subscription.mjs';

const log = makeLogger('curiosity/factcheck');

/**
 * 정정 규칙 — 두 프롬프트(reveal·whatif) 공통. "note 에 글로 적어두면 사람이 읽겠지"가 통하지
 * 않는다는 게 US-010 의 교훈이므로, 기계가 읽을 필드를 반드시 채우게 못 박는다.
 */
const CORRECTION_RULE = `
[정정 규칙 — 반드시 지켜라]
- 수치·금액·연도·단위·고유명사가 틀렸다면, 핵심 주장이 참이라 **verdict 를 ok 로 두더라도**
  needs_correction=true 로 하고 corrected_subject·corrected_reveal 을 **둘 다** 채워라.
- corrected_subject/corrected_reveal 은 "무엇을 고쳐라"는 지시문이 아니라, **그대로 쓸 수 있는
  정정된 완성 문장**이어야 한다(원문과 같은 어투·길이감, 주제는 40자 이내가 좋다).
- 고칠 게 없으면 needs_correction=false, 두 필드는 빈 문자열로 둬라.
- ⚠ note 에만 "수정 필요"라고 적고 정정 문장을 비워 두면 그 아이템은 **발행되지 않고 폐기**된다.
  고칠 수 있으면 반드시 정정 문장으로 제출하라.`;

/** 구형 응답(구조화 필드 없음)에서 "정정 요구"를 읽어내는 신호. 애매하면 막는 쪽. */
export const CORRECTION_SIGNALS = [
  /반드시\s*(수정|정정|교정)/,
  /(수정|정정|교정)\s*(이\s*)?(반드시|필요|해야|할\s*것)/,
  /자릿수/,
  /사실과\s*다르/,
  /틀렸|틀림|오류/,
  /과장(이거나|이며|됨|이다)/,
  // 숫자+단위 뒤에 "아님" — "1억 2,200만 달러 아님" 류의 수치 정정 요구.
  // 단위는 연속 표기("2,200만 달러")를 허용하되, 숫자와 '아님' 사이에 다른 말이 끼면 매칭하지
  // 않는다("1980년 대법원 판결이 도시전설이 아님" 같은 무해한 문장을 잡지 않도록).
  /\d[\d,.]*(\s*(억|만|천|조|원|달러|년|개월|개|명|배|살|위|톤|초|분|시간|일|주|%|퍼센트|킬로그램|킬로|미터|도))*\s*(은|는|이|가)?\s*아님/,
];

/** note 에 강한 정정 요구가 있는가(구형 응답 안전망). */
export function noteDemandsCorrection(note) {
  const s = String(note || '');
  return CORRECTION_SIGNALS.some(re => re.test(s));
}

/** note 가 **제목/주제**의 오류를 지목했는가 — 이 경우 subject 정정이 없으면 적용 불가로 본다. */
export function noteFlagsSubject(note) {
  return /제목|타이틀|주제|subject|자릿수/i.test(String(note || ''));
}

const usableText = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 200) return '';
  // "수정할 것"·"교정 필요" 같은 지시문이 정정 문장 자리에 들어온 경우는 쓸 수 없다.
  if (/^(수정|정정|교정|없음|해당\s*없음|n\/?a)$/i.test(s)) return '';
  if (/(수정|정정|교정)\s*(할\s*것|필요|요망)/.test(s)) return '';
  return s;
};

/**
 * LLM 응답 → 정규화된 판정. 구형 응답(needs_correction 없음)도 죽지 않고 처리한다:
 * verdict=ok 인데 note 에 강한 정정 요구가 있으면 needs_correction=true 로 **끌어올려**
 * (정정 문장은 없으니) 하위 applyCorrection 이 보류시키게 한다 — 알려진 오류 발행 방지.
 */
export function normalizeFactcheck(obj = {}) {
  const verdict = ['ok', 'doubtful', 'false'].includes(obj.verdict) ? obj.verdict : 'doubtful';
  const note = String(obj.note || '');
  const corrected_subject = usableText(obj.corrected_subject);
  const corrected_reveal = usableText(obj.corrected_reveal);
  const hasField = typeof obj.needs_correction === 'boolean';
  const inferred = noteDemandsCorrection(note);
  // 구조화 필드가 있으면 그 값을 쓰되, note 가 정정을 요구하면 false 로 덮어쓰지 못하게 한다
  // (모델이 필드를 false 로 두고 note 에만 "반드시 수정"을 적는 실제 패턴 방어).
  const needs_correction = (hasField ? obj.needs_correction : false) || inferred;
  return {
    verdict, note, source: String(obj.source || ''),
    needs_correction, corrected_subject, corrected_reveal,
    correction_inferred: !hasField && inferred,
  };
}

/**
 * 정정 반영 — 정정본이 subject/reveal 자리를 **대체**해 대본·업로드 제목까지 흘러간다.
 * 적용 불가면 applied=false → 호출자는 발행하지 말고 보류(held)해야 한다.
 * @returns { applied, changed, item, reason }
 */
export function applyCorrection(item, fc = {}) {
  if (!fc.needs_correction) return { applied: true, changed: false, item, reason: 'no_correction_needed' };
  const cs = usableText(fc.corrected_subject);
  const cr = usableText(fc.corrected_reveal);
  // 정정 요구는 있는데 쓸 수 있는 정정 문장이 없다 → 알려진 오류를 내보내지 않는다.
  if (!cs || !cr) return { applied: false, changed: false, item, reason: 'correction_missing' };
  const sameSubject = cs === String(item.subject || '').trim();
  const sameReveal = cr === String(item.reveal || '').trim();
  if (sameSubject && sameReveal) return { applied: false, changed: false, item, reason: 'correction_identical' };
  // note 가 제목/주제의 오류를 지목했는데 주제가 그대로면 정작 틀린 곳이 안 고쳐진 것이다.
  if (noteFlagsSubject(fc.note) && sameSubject) {
    return { applied: false, changed: false, item, reason: 'subject_not_corrected' };
  }
  return {
    applied: true, changed: true, reason: 'corrected',
    item: {
      ...item, subject: cs, reveal: cr,
      factcheck_corrected: true,
      original_subject: item.subject, original_reveal: item.reveal,
    },
  };
}

export function buildPrompt(item) {
  const persona = loadAgentBrief('badger');
  // what-if(가상 추론)는 "가상이 실제로 일어났나"를 묻는 게 아니다 — 사고실험의 '근거 실재성 + 추론 타당성'을 본다.
  if (item.angle === 'whatif') {
    return `${persona ? persona + '\n\n' : ''}아래는 "만약 ~였다면?" 사고실험이다. 이건 실제로 일어난 사실이 아니므로 "참/거짓"으로 판정하지 마라. 대신 **①추론을 지탱하는 근거(source_hint)가 실제로 존재·정확한가, ②결말(추론)이 그 근거와 실제 물리·역사·생리 제약에 비추어 타당한가(근거 없는 판타지·초자연·명백한 오류가 아닌가)** 를 판정하라.

주제(가정): ${item.subject}
흔한 상상: ${item.common_belief}
근거 기반 추론(결말): ${item.reveal}
지탱 근거: ${item.source_hint || '(없음)'}

[출력] JSON 객체만:
{ "verdict": "ok" | "doubtful" | "false", "note": 한 줄 근거/이유, "source": 추론을 지탱하는 실제 근거(현상/법칙/사건, 없으면 빈문자열),
  "needs_correction": true|false, "corrected_subject": 정정된 주제 한 줄, "corrected_reveal": 정정된 결말 한 줄 }
- ok: 근거가 실재하고 추론이 그 근거와 실제 제약에 부합해 그럴듯함. doubtful: 근거가 약하거나 추론에 비약이 큼. false: 근거가 허위이거나 결말이 실제 법칙에 명백히 어긋남(판타지).
${CORRECTION_RULE}`;
  }
  return `${persona ? persona + '\n\n' : ''}아래 "반전 사실" 주장이 실제로 참인지 가볍게(상식·널리 알려진 근거 기준) 판정하라. 과장·도시전설·확인 불가면 통과시키지 마라.

주제: ${item.subject}
흔한 믿음: ${item.common_belief}
반전 주장: ${item.reveal}
근거 단서: ${item.source_hint || '(없음)'}

[출력] JSON 객체만:
{ "verdict": "ok" | "doubtful" | "false", "note": 한 줄 근거/이유, "source": 확인 가능한 근거(기관/현상/연구명, 없으면 빈문자열),
  "needs_correction": true|false, "corrected_subject": 정정된 주제 한 줄, "corrected_reveal": 정정된 반전 한 줄 }
- ok: 널리 확립된 사실. doubtful: 부분적 참·맥락 필요·근거 약함. false: 틀렸거나 도시전설.
${CORRECTION_RULE}`;
}

export async function factCheck(item, { cfg } = {}) {
  cfg = cfg || loadConfig();
  if (!cfg.factcheck?.enabled) return normalizeFactcheck({ verdict: 'ok', note: 'factcheck disabled' });
  const text = callClaude(buildPrompt(item));
  let obj;
  try { obj = extractJson(text); } catch { return normalizeFactcheck({ verdict: 'doubtful', note: '판정 파싱 실패' }); }
  const fc = normalizeFactcheck(obj);
  if (fc.needs_correction) {
    log.warn(fc.correction_inferred
      ? `정정 요구를 note 에서 감지(구형 응답) — 정정 문장 없으면 보류: ${fc.note.slice(0, 160)}`
      : `정정 필요(verdict=${fc.verdict}) → 정정본으로 대체 예정: "${fc.corrected_subject || '(미제출)'}"`);
  }
  return fc;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) { log.error('사용법: factcheck.mjs \'<item-json>\''); process.exit(2); }
  try {
    const r = await factCheck(JSON.parse(raw));
    log.info(`verdict=${r.verdict} :: ${r.note}`);
    process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
  } catch (e) {
    log.error(`검증 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
