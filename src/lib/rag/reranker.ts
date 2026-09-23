import { tokenize } from './tokenizer';
import type { KbDoc, RerankedDoc, ScoredDoc } from './types';

export function rerank(
  query: string,
  candidates: ScoredDoc[],
  docsById: Map<string, KbDoc>,
  topN: number,
): RerankedDoc[] {
  const qTokens = new Set(tokenize(query));
  const scored = candidates.map((c) => {
    const doc = docsById.get(c.id);
    const tokens = new Set(doc ? tokenize(`${doc.title} ${doc.content}`) : []);
    let matches = 0;
    for (const t of qTokens) {
      if (tokens.has(t)) matches++;
    }
    return { id: c.id, score: c.score, matches };
  });
  scored.sort((a, b) => b.matches - a.matches || b.score - a.score);
  return scored.slice(0, topN).map(({ id, score, matches }) => ({ id, score, matches }));
}
