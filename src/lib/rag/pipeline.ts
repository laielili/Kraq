import { EmbeddingClient, LLMClient, Config } from 'coze-coding-dev-sdk';
import { cosineSimilarity } from './vector';
import { bm25Search } from './bm25';
import { classifyIntent } from './intent';
import { rerank } from './reranker';
import { validateAnswer } from './validator';
import { ensureEmbeddings, getKb, getConfig } from '@/lib/kb/store';
import type {
  AskEvent,
  KbDoc,
  RagConfig,
  RagConfigPatch,
  ScoredDoc,
  SourceDoc,
} from './types';

const OUT_OF_SCOPE_ANSWER = '抱歉，该问题超出了本知识库的服务范围，我无法回答。';
const EMPTY_KB_ANSWER = '知识库暂无文档，请先在左侧「档案柜」中添加资料后再提问。';

const SYSTEM_PROMPT =
  '你是一个知识库问答助手。请根据以下提供的资料回答用户问题，并在答案中使用方括号标注引用编号，如 [1]、[2]。如果资料不足以回答问题，请明确说明资料中未涉及，不要编造。';

function buildUserPrompt(question: string, contexts: KbDoc[]): string {
  const material = contexts
    .map((c, i) => `[${i + 1}] ${c.title}：${c.content}`)
    .join('\n');
  return `用户问题：${question}\n\n资料：\n${material}\n\n答案：`;
}

function rrfFuse(
  bm25: ScoredDoc[],
  vector: ScoredDoc[],
  bm25Weight: number,
  vectorWeight: number,
): ScoredDoc[] {
  const k = 60;
  const scores = new Map<string, number>();
  bm25.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + bm25Weight / (k + i + 1)));
  vector.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + vectorWeight / (k + i + 1)));
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function toTitleMap(docs: KbDoc[]): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const d of docs) titles[d.id] = d.title;
  return titles;
}

export async function* runAsk(
  question: string,
  overrides: RagConfigPatch,
  customHeaders: Record<string, string>,
): AsyncGenerator<AskEvent> {
  const stored = await getConfig();
  const cfg: RagConfig = { ...stored, ...overrides };
  const docs = await getKb();

  const intent = classifyIntent(question);
  yield { type: 'stage', stage: 'intent', data: { intent } };

  if (intent === 'OUT_OF_SCOPE') {
    yield { type: 'done', answer: OUT_OF_SCOPE_ANSWER, sources: [] };
    return;
  }
  if (!docs.length) {
    yield {
      type: 'stage',
      stage: 'retrieve',
      data: { vectorAvailable: false, bm25: [], vector: [], fused: [], titles: {} },
    };
    yield { type: 'done', answer: EMPTY_KB_ANSWER, sources: [] };
    return;
  }

  const candidateK = cfg.topK * 2;
  const bm25Results = bm25Search(question, docs, candidateK);

  let vectorAvailable = true;
  let vectorResults: ScoredDoc[] = [];
  try {
    await ensureEmbeddings(customHeaders);
    const embeddingClient = new EmbeddingClient(new Config(), customHeaders);
    const queryEmbedding = await embeddingClient.embedText(question);
    vectorResults = docs
      .filter((d): d is KbDoc & { embedding: number[] } => d.embedding !== null)
      .map((d) => ({ id: d.id, score: cosineSimilarity(queryEmbedding, d.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateK);
  } catch {
    vectorAvailable = false;
  }

  const fused = rrfFuse(bm25Results, vectorResults, cfg.bm25Weight, cfg.vectorWeight);
  const titles = toTitleMap(docs);
  yield { type: 'stage', stage: 'retrieve', data: { vectorAvailable, bm25: bm25Results, vector: vectorResults, fused, titles } };

  const docsById = new Map(docs.map((d) => [d.id, d]));
  const reranked = rerank(question, fused, docsById, cfg.topK);
  yield { type: 'stage', stage: 'rerank', data: { reranked, titles } };

  const contexts = reranked
    .map((r) => docsById.get(r.id))
    .filter((d): d is KbDoc => d !== undefined);

  yield { type: 'stage', stage: 'generate', data: { model: cfg.model } };

  const llm = new LLMClient(new Config(), customHeaders);
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(question, contexts) },
  ];
  const stream = llm.stream(messages, {
    model: cfg.model,
    temperature: cfg.temperature,
    thinking: 'disabled',
  });

  let answer = '';
  for await (const chunk of stream) {
    if (chunk.content) {
      const text = chunk.content.toString();
      answer += text;
      yield { type: 'delta', text };
    }
  }

  const sources: SourceDoc[] = reranked.map((r) => {
    const doc = docsById.get(r.id);
    return { id: r.id, title: doc?.title ?? r.id, content: doc?.content ?? '', score: r.score };
  });

  if (cfg.enableValidation) {
    const validation = validateAnswer(answer, contexts.map((c) => c.content));
    yield { type: 'stage', stage: 'validate', data: validation };
  }

  yield { type: 'done', answer, sources };
}
