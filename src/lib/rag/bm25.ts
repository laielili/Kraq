import { tokenize } from './tokenizer';
import type { ScoredDoc } from './types';

const K1 = 1.5;
const B = 0.75;

export function bm25Search(
  query: string,
  docs: Array<{ id: string; title: string; content: string }>,
  topK: number,
): ScoredDoc[] {
  const qTokens = tokenize(query);
  if (!qTokens.length || !docs.length) return [];

  const docTokens = docs.map((d) => tokenize(`${d.title} ${d.content}`));
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length;
  const avgdl = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / n || 1;

  const scored: ScoredDoc[] = [];
  for (let i = 0; i < docs.length; i++) {
    const tokens = docTokens[i] ?? [];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = tokens.length || 1;
    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const dfT = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + B * (dl / avgdl)));
    }
    if (score > 0) scored.push({ id: docs[i].id, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
