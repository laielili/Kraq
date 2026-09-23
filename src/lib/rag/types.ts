export type IntentLabel = 'FAQ' | 'SEARCH' | 'CLARIFY' | 'OUT_OF_SCOPE';

export interface KbDoc {
  id: string;
  title: string;
  content: string;
  embedding: number[] | null;
  createdAt: string;
}

export interface KbDocMeta {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  embedded: boolean;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

export interface RerankedDoc extends ScoredDoc {
  matches: number;
}

export interface RetrievalTrace {
  vectorAvailable: boolean;
  bm25: ScoredDoc[];
  vector: ScoredDoc[];
  fused: ScoredDoc[];
}

export interface RagConfig {
  model: string;
  temperature: number;
  topK: number;
  bm25Weight: number;
  vectorWeight: number;
  enableValidation: boolean;
}

export type RagConfigPatch = Partial<Omit<RagConfig, 'model'>> & { model?: string };

export interface SourceDoc {
  id: string;
  title: string;
  content: string;
  score: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  note: string;
}

export type AskEvent =
  | { type: 'stage'; stage: 'intent'; data: { intent: IntentLabel } }
  | { type: 'stage'; stage: 'retrieve'; data: RetrievalTrace & { titles: Record<string, string> } }
  | { type: 'stage'; stage: 'rerank'; data: { reranked: RerankedDoc[]; titles: Record<string, string> } }
  | { type: 'stage'; stage: 'generate'; data: { model: string } }
  | { type: 'delta'; text: string }
  | { type: 'stage'; stage: 'validate'; data: { valid: boolean; citations: number[]; reason: string } }
  | { type: 'done'; answer: string; sources: SourceDoc[] }
  | { type: 'error'; message: string };

export type StageName = 'intent' | 'retrieve' | 'rerank' | 'generate' | 'validate';

export interface TraceState {
  intent?: IntentLabel;
  retrieval?: (RetrievalTrace & { titles: Record<string, string> }) | null;
  reranked?: RerankedDoc[];
  titles?: Record<string, string>;
  validation?: { valid: boolean; citations: number[]; reason: string } | null;
  current: StageName | 'done' | null;
}
