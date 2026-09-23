export interface ValidationResult {
  valid: boolean;
  citations: number[];
  reason: string;
}

export function validateAnswer(answer: string, contexts: string[]): ValidationResult {
  const citations = Array.from(answer.matchAll(/\[(\d+)\]/g))
    .map((m) => Number.parseInt(m[1] ?? '', 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!citations.length) {
    return { valid: false, citations: [], reason: '回答缺少引用标注 [n]' };
  }
  const outOfRange = citations.filter((n) => n > contexts.length);
  if (outOfRange.length) {
    return {
      valid: false,
      citations,
      reason: `引用编号越界: [${Array.from(new Set(outOfRange)).join('], [')}]，资料共 ${contexts.length} 条`,
    };
  }
  const totalLen = contexts.reduce((sum, c) => sum + c.length, 0);
  if (answer.length > totalLen * 2) {
    return { valid: false, citations, reason: '回答长度远超资料长度，疑似幻觉' };
  }
  return { valid: true, citations, reason: `引用编号均在资料范围内（共 ${citations.length} 处）` };
}
