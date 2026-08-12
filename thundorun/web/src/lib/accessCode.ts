// SAJU_ACCESS_CODE 해석 헬퍼.
// Windows CLI stdin 으로는 한글 env 값이 깨져서, "b64:<base64(UTF-8)>" 표기를 함께 지원한다.
// 평문(예: Vercel 대시보드에서 직접 입력)도 그대로 동작한다.
// edge/node 양쪽 런타임에서 쓰이므로 Buffer 대신 atob + TextDecoder 를 사용한다.
export function resolveAccessCode(): string | undefined {
  // CLI stdin 등록 시 BOM(U+FEFF)·zero-width(U+200B)가 값에 붙는 경우가 있어 제거한다.
  // \uD658\uACBD\uBCC0\uC218\uB294 SECRET_CODE \uC6B0\uC120, \uC5C6\uC73C\uBA74 \uAE30\uC874 SAJU_ACCESS_CODE \uD3F4\uBC31(\uD558\uC704\uD638\uD658)
  const raw = (process.env.SECRET_CODE ?? process.env.SAJU_ACCESS_CODE)?.replace(/^[\s\uFEFF\u200B]+|[\s\uFEFF\u200B]+$/g, '');
  if (!raw) return undefined;
  if (raw.startsWith('b64:')) {
    try {
      const bytes = Uint8Array.from(atob(raw.slice(4)), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes).trim();
    } catch {
      return undefined;
    }
  }
  return raw;
}

export async function accessCodeToken(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
