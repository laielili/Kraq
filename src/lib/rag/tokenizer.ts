export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lowered.matchAll(/[a-z0-9]+/g)) {
    tokens.push(m[0]);
  }
  for (const run of lowered.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = Array.from(run[0]);
    for (const ch of chars) tokens.push(ch);
    for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}
