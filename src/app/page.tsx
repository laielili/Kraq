'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  BookOpenText,
  Loader2,
  Settings2,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ChatPanel, type ChatMessage } from '@/components/rag/chat-panel';
import { KbPanel } from '@/components/rag/kb-panel';
import { TracePanel } from '@/components/rag/trace-panel';
import type {
  AskEvent,
  KbDocMeta,
  ModelInfo,
  RagConfig,
  TraceState,
} from '@/lib/rag/types';

const DEFAULT_CONFIG: RagConfig = {
  model: 'doubao-seed-2-0-pro-260215',
  temperature: 0.7,
  topK: 5,
  bm25Weight: 0.4,
  vectorWeight: 0.6,
  enableValidation: true,
};

export default function Home() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [config, setConfig] = useState<RagConfig | null>(null);
  const [docs, setDocs] = useState<KbDocMeta[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceState | null>(null);
  const [streaming, setStreaming] = useState(false);

  const configRef = useRef<RagConfig>(DEFAULT_CONFIG);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    configRef.current = config ?? DEFAULT_CONFIG;
  }, [config]);

  const refreshKb = useCallback(async () => {
    try {
      const res = await fetch('/api/kb');
      const data = (await res.json()) as { docs?: KbDocMeta[] };
      setDocs(data.docs ?? []);
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [modelsRes, configRes] = await Promise.all([
        fetch('/api/models').catch(() => null),
        fetch('/api/config').catch(() => null),
      ]);
      if (modelsRes?.ok) {
        const data = (await modelsRes.json()) as { models?: ModelInfo[] };
        setModels(data.models ?? []);
      }
      if (configRes?.ok) {
        const data = (await configRes.json()) as Partial<RagConfig>;
        setConfig({ ...DEFAULT_CONFIG, ...data });
      } else {
        setConfig(DEFAULT_CONFIG);
      }
      await refreshKb();
    })();
  }, [refreshKb]);

  const updateConfig = useCallback((patch: Partial<RagConfig>) => {
    setConfig((prev) => {
      const next = { ...(prev ?? DEFAULT_CONFIG), ...patch };
      void fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      return next;
    });
  }, []);

  const applyEvent = useCallback((ev: AskEvent) => {
    if (ev.type === 'stage') {
      setTrace((prev) => {
        const base: TraceState = prev ?? { current: ev.stage };
        switch (ev.stage) {
          case 'intent':
            return { ...base, intent: ev.data.intent, current: 'intent' };
          case 'retrieve':
            return {
              ...base,
              retrieval: ev.data,
              titles: ev.data.titles,
              current: 'retrieve',
            };
          case 'rerank':
            return {
              ...base,
              reranked: ev.data.reranked,
              titles: ev.data.titles,
              current: 'rerank',
            };
          case 'generate':
            return { ...base, current: 'generate' };
          case 'validate':
            return { ...base, validation: ev.data, current: 'validate' };
          default:
            return base;
        }
      });
      return;
    }
    if (ev.type === 'delta') {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, content: last.content + ev.text };
        }
        return next;
      });
      return;
    }
    if (ev.type === 'done') {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            content: last.content || ev.answer,
            sources: ev.sources,
            streaming: false,
          };
        }
        return next;
      });
      setTrace((prev) => (prev ? { ...prev, current: 'done' } : prev));
      return;
    }
    if (ev.type === 'error') {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            content: last.content ? `${last.content}\n\n${ev.message}` : ev.message,
            error: true,
            streaming: false,
          };
        }
        return next;
      });
    }
  }, []);

  const send = useCallback(
    async (question: string) => {
      if (streamingRef.current) return;
      streamingRef.current = true;
      setStreaming(true);
      setTrace(null);
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: question },
        { role: 'assistant', content: '', streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      const cfg = configRef.current;
      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            config: {
              model: cfg.model,
              temperature: cfg.temperature,
              topK: cfg.topK,
              bm25Weight: cfg.bm25Weight,
              vectorWeight: cfg.vectorWeight,
              enableValidation: cfg.enableValidation,
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`请求失败（${res.status}），请稍后重试`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk
              .split('\n')
              .find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              applyEvent(JSON.parse(line.slice(6)) as AskEvent);
            } catch {
              // 跳过无法解析的片段
            }
          }
        }
      } catch (e) {
        const aborted =
          e instanceof DOMException && e.name === 'AbortError';
        if (!aborted) {
          applyEvent({
            type: 'error',
            message: e instanceof Error ? e.message : '网络异常，请稍后重试',
          });
        }
      } finally {
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false };
          }
          return next;
        });
      }
    },
    [applyEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant');

  const tracePanel = (
    <TracePanel
      trace={trace}
      sources={lastAssistant?.sources ?? []}
      streaming={streaming}
      validationEnabled={config?.enableValidation ?? true}
    />
  );

  const kbPanel = <KbPanel docs={docs} onMutated={refreshKb} />;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-sidebar/80 px-3 backdrop-blur-sm lg:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BookOpenText className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-serif text-sm font-semibold leading-tight">
              DataAgent · 知识库智能问答
            </h1>
            <p className="truncate text-[10px] leading-tight text-muted-foreground">
              意图识别 · 混合检索 · 重排序 · 引用生成 · 幻觉校验
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="打开知识库"
              >
                <Archive className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" aria-describedby={undefined} className="w-80 gap-0 p-0">
              <SheetTitle className="sr-only">知识库</SheetTitle>
              <div className="h-full">{kbPanel}</div>
            </SheetContent>
          </Sheet>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="xl:hidden"
                aria-label="打开流程追溯"
              >
                <Workflow className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" aria-describedby={undefined} className="w-96 gap-0 p-0">
              <SheetTitle className="sr-only">流程追溯</SheetTitle>
              <div className="h-full">{tracePanel}</div>
            </SheetContent>
          </Sheet>

          <Select
            value={config?.model ?? ''}
            onValueChange={(v) => updateConfig({ model: v })}
            disabled={!config || streaming}
          >
            <SelectTrigger className="h-9 w-32 text-xs sm:w-56">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-muted-foreground"> · {m.note}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                aria-label="检索与生成参数"
                disabled={!config}
              >
                <Settings2 className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              {config ? (
                <div className="space-y-4">
                  <p className="font-serif text-xs font-semibold">参数</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>生成温度</span>
                      <span className="font-mono">
                        {config.temperature.toFixed(1)}
                      </span>
                    </div>
                    <Slider
                      value={[config.temperature]}
                      min={0}
                      max={1}
                      step={0.1}
                      onValueChange={(v) =>
                        updateConfig({ temperature: v[0] ?? 0.7 })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>引用资料条数</span>
                      <span className="font-mono">{config.topK}</span>
                    </div>
                    <Slider
                      value={[config.topK]}
                      min={1}
                      max={10}
                      step={1}
                      onValueChange={(v) => updateConfig({ topK: v[0] ?? 5 })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>BM25 权重</span>
                      <span className="font-mono">
                        {config.bm25Weight.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.bm25Weight]}
                      min={0}
                      max={1}
                      step={0.05}
                      onValueChange={(v) =>
                        updateConfig({ bm25Weight: v[0] ?? 0.4 })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>向量检索权重</span>
                      <span className="font-mono">
                        {config.vectorWeight.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.vectorWeight]}
                      min={0}
                      max={1}
                      step={0.05}
                      onValueChange={(v) =>
                        updateConfig({ vectorWeight: v[0] ?? 0.6 })
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span>引用与幻觉校验</span>
                    <Switch
                      checked={config.enableValidation}
                      onCheckedChange={(v: boolean) =>
                        updateConfig({ enableValidation: v })
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  配置加载中…
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r bg-sidebar/40 lg:block">
          {kbPanel}
        </aside>
        <main className="min-w-0 flex-1">
          <ChatPanel
            messages={messages}
            streaming={streaming}
            onSend={send}
            onStop={stop}
          />
        </main>
        <aside className="hidden w-80 shrink-0 border-l bg-sidebar/40 xl:block">
          {tracePanel}
        </aside>
      </div>
    </div>
  );
}
