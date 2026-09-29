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

export type EndpointProtocol = 'ollama' | 'openai' | 'llamacpp';

export interface EndpointConfig {
  id: string;
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  /** 前端提交时用：apiKey 为 null 表示保留后端已存值 */
  apiKey?: string | null;
  /** 后端返回：true = 已存 Key（前端不回显明文） */
  hasKey?: boolean;
}

export type StageKey = 'intent' | 'embedding' | 'rerank' | 'generate' | 'validate';

export interface StageCfg {
  endpointId: string | null;
  model: string;
}

/** intent stage 事件的追溯数据 */
export interface IntentStageDetail {
  intent: IntentLabel;
  /** 最终标签由谁给出：llm / rule */
  finalBy?: 'llm' | 'rule';
}

export interface ChunkingCfg {
  maxChars: number;
  overlap: number;
}

export interface RagConfig {
  endpoints: EndpointConfig[];
  stages: Record<StageKey, StageCfg>;
  temperature: number;
  /** 旧检索旋钮，保留兼容；新代码用 retrieveTopK / rerankTopN */
  topK: number;
  /** 召回候选数：BM25 / 向量各取前 K（业界 recall_k） */
  retrieveTopK: number;
  /** 重排后保留进生成上下文的条数（业界 top_n） */
  rerankTopN: number;
  bm25Weight: number;
  vectorWeight: number;
  enableValidation: boolean;
  chunking: ChunkingCfg;
}

export type RagConfigPatch = Partial<RagConfig>;

export interface SourceDoc {
  id: string;
  title: string;
  content: string;
  score: number;
}

export type AskEvent =
  | { type: 'stage'; stage: 'intent'; data: IntentStageDetail }
  | { type: 'stage'; stage: 'retrieve'; data: RetrievalTrace & { titles: Record<string, string> } }
  | { type: 'stage'; stage: 'rerank'; data: { reranked: RerankedDoc[]; titles: Record<string, string> } }
  | { type: 'stage'; stage: 'generate'; data: { model: string } }
  | { type: 'thinking'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'stage'; stage: 'validate'; data: { valid: boolean; citations: number[]; reason: string } }
  | { type: 'done'; answer: string; sources: SourceDoc[] }
  | { type: 'error'; message: string };

export type StageName = 'intent' | 'retrieve' | 'rerank' | 'generate' | 'validate';

export interface TraceState {
  intent?: IntentLabel;
  /** intent 阶段追溯（LLM 判定 / 规则兜底） */
  intentDetail?: IntentStageDetail | null;
  retrieval?: (RetrievalTrace & { titles: Record<string, string> }) | null;
  reranked?: RerankedDoc[];
  titles?: Record<string, string>;
  validation?: { valid: boolean; citations: number[]; reason: string } | null;
  current: StageName | 'done' | null;
}
