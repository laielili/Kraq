import { promises as fs } from 'fs';
import path from 'path';
import { Config, EmbeddingClient } from 'coze-coding-dev-sdk';
import { SEED_DOCS } from './seed';
import type { KbDoc, KbDocMeta, RagConfig } from '@/lib/rag/types';

const DATA_DIR = path.join(process.cwd(), 'data');
const KB_FILE = path.join(DATA_DIR, 'kb.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG: RagConfig = {
  model: 'doubao-seed-2-0-pro-260215',
  temperature: 0.7,
  topK: 5,
  bm25Weight: 0.4,
  vectorWeight: 0.6,
  enableValidation: true,
};

let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

async function loadOrSeedKb(): Promise<KbDoc[]> {
  try {
    const raw = await fs.readFile(KB_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { docs?: unknown };
    if (parsed && Array.isArray(parsed.docs)) {
      return parsed.docs.filter((d): d is KbDoc => {
        if (typeof d !== 'object' || d === null) return false;
        const doc = d as Partial<KbDoc>;
        return (
          typeof doc.id === 'string' &&
          typeof doc.title === 'string' &&
          typeof doc.content === 'string'
        );
      });
    }
  } catch {
    // fallthrough to seed
  }
  const now = new Date().toISOString();
  const docs: KbDoc[] = SEED_DOCS.map((d, i) => ({
    id: `seed-${String(i + 1).padStart(2, '0')}`,
    title: d.title,
    content: d.content,
    embedding: null,
    createdAt: now,
  }));
  await writeJson(KB_FILE, { docs });
  return docs;
}

async function readConfig(): Promise<RagConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RagConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function clampConfig(patch: Partial<RagConfig>): RagConfig {
  const model = typeof patch.model === 'string' && patch.model.trim() ? patch.model.trim() : DEFAULT_CONFIG.model;
  const clamp = (v: number | undefined, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    model,
    temperature: clamp(patch.temperature, 0, 1, DEFAULT_CONFIG.temperature),
    topK: Math.round(clamp(patch.topK, 1, 10, DEFAULT_CONFIG.topK)),
    bm25Weight: clamp(patch.bm25Weight, 0, 1, DEFAULT_CONFIG.bm25Weight),
    vectorWeight: clamp(patch.vectorWeight, 0, 1, DEFAULT_CONFIG.vectorWeight),
    enableValidation:
      typeof patch.enableValidation === 'boolean' ? patch.enableValidation : DEFAULT_CONFIG.enableValidation,
  };
}

export async function getKb(): Promise<KbDoc[]> {
  return withLock(loadOrSeedKb);
}

export async function listDocs(): Promise<KbDocMeta[]> {
  const docs = await getKb();
  return docs.map((d) => ({
    id: d.id,
    title: d.title,
    content: d.content,
    createdAt: d.createdAt,
    embedded: d.embedding !== null,
  }));
}

export async function ensureEmbeddings(customHeaders: Record<string, string>): Promise<void> {
  await withLock(async () => {
    const docs = await loadOrSeedKb();
    const missing = docs.filter((d) => d.embedding === null);
    if (!missing.length) return;
    const client = new EmbeddingClient(new Config(), customHeaders);
    for (const doc of missing) {
      doc.embedding = await client.embedText(`${doc.title} ${doc.content}`);
      await writeJson(KB_FILE, { docs });
    }
  });
}

export async function addDoc(
  title: string,
  content: string,
): Promise<KbDocMeta> {
  const created = await withLock(async () => {
    const docs = await loadOrSeedKb();
    const doc: KbDoc = {
      id: crypto.randomUUID(),
      title,
      content,
      embedding: null,
      createdAt: new Date().toISOString(),
    };
    docs.push(doc);
    await writeJson(KB_FILE, { docs });
    return doc;
  });
  return { id: created.id, title: created.title, content: created.content, createdAt: created.createdAt, embedded: false };
}

export async function deleteDoc(id: string): Promise<boolean> {
  return withLock(async () => {
    const docs = await loadOrSeedKb();
    const next = docs.filter((d) => d.id !== id);
    if (next.length === docs.length) return false;
    await writeJson(KB_FILE, { docs: next });
    return true;
  });
}

export async function getConfig(): Promise<RagConfig> {
  return withLock(readConfig);
}

export async function updateConfig(patch: Partial<RagConfig>): Promise<RagConfig> {
  return withLock(async () => {
    const current = await readConfig();
    const next = clampConfig({ ...current, ...patch });
    await writeJson(CONFIG_FILE, next);
    return next;
  });
}
