/**
 * lib/faq.ts — FAQ 섹션 파서 (faq-contract.md 준수)
 * 마크다운 content에서 `## 자주 묻는 질문` H2 아래
 * `**Q. ...?**` / `A. ...` 쌍을 추출한다.
 * Q&A 쌍이 3개 미만이면 빈 배열 반환 (faq-contract.md 규칙 3).
 */

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * 마크다운 content에서 FAQ 쌍을 파싱.
 *
 * 규칙 (faq-contract.md):
 *  - 섹션 헤딩: 정확히 `## 자주 묻는 질문` (H2, 이 문자열 그대로)
 *  - 질문: `**Q. ...**` 볼드 라인 (물음표로 끝남)
 *  - 답변: 다음 비어있지 않은 문단의 `A. ` 접두 라인
 *  - 3개 미만 → 빈 배열 (FAQPage JSON-LD 미출력)
 */
export function parseFaq(content: string): FaqItem[] {
  // H2 정확 매칭: "## 자주 묻는 질문" (행 단위, 앞뒤 공백 허용)
  const sectionMatch = content.match(/^##\s+자주 묻는 질문\s*$/m);
  if (!sectionMatch || sectionMatch.index === undefined) return [];

  // 해당 섹션 이후부터 다음 H2(##) 전까지만 추출
  const afterSection = content.slice(sectionMatch.index + sectionMatch[0].length);
  const nextH2Index = afterSection.search(/^##\s+/m);
  const sectionContent = nextH2Index === -1 ? afterSection : afterSection.slice(0, nextH2Index);

  const pairs: FaqItem[] = [];
  const lines = sectionContent.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // 질문 라인: **Q. 질문 내용?** 형태
    const qMatch = line.match(/^\*\*Q\.\s+(.+?)\*\*$/);
    if (qMatch) {
      const question = qMatch[1].trim();

      // 다음 비어있지 않은 라인에서 답변(`A. `) 탐색
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;

      if (j < lines.length) {
        const ansLine = lines[j].trim();
        const aMatch = ansLine.match(/^A\.\s+(.+)$/);
        if (aMatch) {
          pairs.push({ question, answer: aMatch[1].trim() });
          i = j + 1;
          continue;
        }
      }
    }
    i++;
  }

  // 3개 미만이면 FAQ 섹션으로 인정하지 않음 (faq-contract.md 규칙 3)
  return pairs.length >= 3 ? pairs : [];
}
