export type IntentLabel = 'FAQ' | 'OUT_OF_SCOPE' | 'CONTINUATION';

export interface KbDocMeta {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  embedded: boolean;
  /** 本库是否留存了该来源的 Markdown 原文：决定「重新嵌入」能否重切它 */
  hasSource?: boolean;
}

/** 「重新嵌入」后台任务快照（POST/GET /api/kbs/{kbId}/reembed） */
export interface ReembedJob {
  kbId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  total: number;
  done: number;
  error: string | null;
  model?: string;
  /** 按当前策略重切成功的来源数（有留存原文的） */
  rechunked?: number;
  /** 改造前入库、无留存原文，只做重嵌的来源数 */
  keptNoRaw?: number;
  /** 向量集合是否已清空：为 true 时本库提问退到 BM25 单腿 */
  cleared?: boolean;
}

/** 「补算待向量化文档」后台任务快照（POST/GET /api/kbs/{kbId}/embed） */
export interface EmbedJob {
  kbId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  total: number;
  done: number;
  error: string | null;
  model?: string;
}

/** per-KB 嵌入选型（向量嵌入模型已下沉到知识库维度） */
export interface KbEmbeddingCfg {
  endpointId: string | null;
  model: string;
}

/** per-KB 汇总（GET /api/kbs 单项） */
export interface KbSettings {
  embedding: KbEmbeddingCfg;
  chunking: ChunkingCfg;
  /** 知识库简介（意图路由的速览元数据，留空未填） */
  description?: string;
  /** 本库示例问题（对话面板空态的快捷提问，最多 4 条，留空不显示） */
  suggestions?: string[];
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
  /** FAQ 主链路：top-1 向量余弦分与其阈值（CLARIFY gate 依据） */
  top1Score?: number;
  threshold?: number;
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
  /** CLARIFY 分支：top-1 向量余弦分低于阈值，触发澄清式生成 */
  clarify?: boolean;
  /** CONTINUATION 分支：本轮是对上一轮澄清的补充，生成时会带上会话历史 */
  continuation?: boolean;
  top1Score?: number;
  threshold?: number;
}

/** 切块策略 id，与后端 `splitters.STRATEGIES` 一一对应 */
export type ChunkStrategy = 'recursive' | 'character' | 'markdown_header' | 'json';

export type ChunkParamValue = string | string[] | boolean;

/** 策略专属参数；键集合由后端按 STRATEGY_PARAMS 白名单过滤后才回传 */
export type ChunkParams = Record<string, ChunkParamValue>;

export interface ChunkFieldOption {
  value: string;
  label: string;
}

/** GET /api/chunking/schema 的单个参数控件描述（后端 UI_SCHEMA 是唯一事实源） */
export type ChunkFieldSchema =
  | { key: string; label: string; type: 'select'; default: string; options: ChunkFieldOption[] }
  | { key: string; label: string; type: 'multiselect'; default: string[]; options: ChunkFieldOption[] }
  | { key: string; label: string; type: 'text'; default: string; placeholder?: string }
  | { key: string; label: string; type: 'bool'; default: boolean };

export interface ChunkStrategySchema {
  id: ChunkStrategy;
  label: string;
  hint?: string;
  fields: ChunkFieldSchema[];
}

export interface ChunkingSchemaResp {
  strategies: ChunkStrategySchema[];
}

export interface ChunkingCfg {
  strategy: ChunkStrategy;
  maxChars: number;
  overlap: number;
  params: ChunkParams;
}

export interface RagConfig {
  endpoints: EndpointConfig[];
  stages: Record<Exclude<StageKey, 'embedding'>, StageCfg>;
  temperature: number;
  /** 旧检索旋钮，保留兼容；新代码用 retrieveTopK / rerankTopN */
  topK: number;
  /** 召回候选数：BM25 / 向量各取前 K（业界 recall_k） */
  retrieveTopK: number;
  /** 重排后保留进生成上下文的条数（业界 top_n） */
  rerankTopN: number;
  bm25Weight: number;
  vectorWeight: number;
  /** CLARIFY 分支：top-1 向量余弦分数低于该阈值 → 澄清而非作答 */
  clarifyThreshold: number;
  enableValidation: boolean;
}

export interface SourceDoc {
  id: string;
  title: string;
  content: string;
  score: number;
}

/** 事件来自哪条管线。前端先按 pipeline 分派，再按 stage 渲染（spec §0.6-C2）。 */
export type PipelineId = 'rag' | 'data' | 'search';

export type AskEvent =
  | { type: 'stage'; pipeline: PipelineId; stage: 'intent'; data: IntentStageDetail }
  | { type: 'stage'; pipeline: PipelineId; stage: 'requery'; data: { query: string; fallback?: boolean } }
  | { type: 'stage'; pipeline: PipelineId; stage: 'retrieve'; data: RetrievalTrace & { titles: Record<string, string> } }
  | { type: 'stage'; pipeline: PipelineId; stage: 'rerank'; data: { reranked: RerankedDoc[]; titles: Record<string, string> } }
  | { type: 'stage'; pipeline: PipelineId; stage: 'generate'; data: { model: string } }
  | { type: 'thinking'; pipeline: PipelineId; text: string }
  | { type: 'delta'; pipeline: PipelineId; text: string }
  | { type: 'stage'; pipeline: PipelineId; stage: 'validate'; data: { valid: boolean; citations: number[]; reason: string } }
  | { type: 'done'; pipeline: PipelineId; answer: string; sources: SourceDoc[] }
  | { type: 'error'; pipeline: PipelineId; message: string };

export type StageName = 'intent' | 'requery' | 'retrieve' | 'rerank' | 'generate' | 'validate';

export interface TraceState {
  intent?: IntentLabel;
  /** intent 阶段追溯（LLM 判定 / 规则兜底） */
  intentDetail?: IntentStageDetail | null;
  /** CONTINUATION 专用：意图模型重写出的检索查询 */
  requery?: { query: string; fallback?: boolean } | null;
  retrieval?: (RetrievalTrace & { titles: Record<string, string> }) | null;
  reranked?: RerankedDoc[];
  titles?: Record<string, string>;
  validation?: { valid: boolean; citations: number[]; reason: string } | null;
  current: StageName | 'done' | null;
}
