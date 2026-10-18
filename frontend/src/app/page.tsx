'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  BookOpenText,
  ChevronDown,
  Library,
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
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ChatPanel, type ChatMessage } from '@/components/rag/chat-panel';
import { KbPanel } from '@/components/rag/kb-panel';
import { LinkClipQueueDialog } from '@/components/rag/link-clip-queue-dialog';
import { useLinkClipTasks } from '@/lib/rag/link-clip';
import {
  KbManagerDialog,
  type KbSummary,
} from '@/components/rag/kb-manager-dialog';
import { ModelConfigDialog } from '@/components/rag/model-config-dialog';
import { PromptConfigDialog } from '@/components/rag/prompt-config-dialog';
import { TracePanel } from '@/components/rag/trace-panel';
import type {
  AskEvent,
  KbDocMeta,
  KbEmbeddingCfg,
  KbSettings,
  RagConfig,
  ReembedJob,
  TraceState,
} from '@/lib/rag/types';

/** 轮询「重新嵌入」任务的上限：本地端点约 3~4s/篇，超时只是停止等待不再空转 */
const REEMBED_POLL_TIMEOUT_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CONFIG: RagConfig = {
  endpoints: [],
  stages: {
    intent: { endpointId: null, model: '' },
    rerank: { endpointId: null, model: '' },
    generate: { endpointId: null, model: '' },
    validate: { endpointId: null, model: '' },
  },
  temperature: 0.7,
  topK: 5,
  retrieveTopK: 10,
  rerankTopN: 5,
  bm25Weight: 0.4,
  vectorWeight: 0.6,
  clarifyThreshold: 0.72,
  enableValidation: true,
};

export default function Home() {
  const [config, setConfig] = useState<RagConfig | null>(null);
  // 当前库的 per-KB 嵌入选型（配置模型弹窗只读展示用，随 refreshKb 同步）
  const [kbEmbedding, setKbEmbedding] = useState<KbEmbeddingCfg | null>(null);
  const [kbSuggestions, setKbSuggestions] = useState<string[]>([]);
  const [docs, setDocs] = useState<KbDocMeta[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceState | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [putError, setPutError] = useState<string | null>(null);
  const [currentKbIdState, setCurrentKbId] = useState('default');
  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [kbsLoading, setKbsLoading] = useState(false);
  const [kbActionPending, setKbActionPending] = useState(false);
  const [kbSwitcherOpen, setKbSwitcherOpen] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  // 转存队列弹窗（状态见下方 useLinkClipTasks）
  const [queueOpen, setQueueOpen] = useState(false);
  // 提示词配置弹窗（知识问答 Agent 全局系统提示词；自「配置模型」顶部按钮进入）
  const [promptOpen, setPromptOpen] = useState(false);

  const configRef = useRef<RagConfig>(DEFAULT_CONFIG);
  const currentKbIdRef = useRef('default');
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 思考计时（跨 applyEvent/send 两个闭包共享）
  const thinkingStartRef = useRef<number | null>(null);
  const thinkingEndRef = useRef<number | null>(null);
  // 会话 ID：页面生命周期内稳定（同一页面多次提问共用），刷新/关闭即作废。
  // 随请求体传给后端，供 openai 网关（如 opencode go）的 prompt 缓存命中。
  const sessionIdRef = useRef(
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36),
  );

  useEffect(() => {
    configRef.current = config ?? DEFAULT_CONFIG;
  }, [config]);

  const currentKbId = currentKbIdState;
  useEffect(() => {
    currentKbIdRef.current = currentKbId;
  }, [currentKbId]);

  const CURRENT_KB_KEY = 'kraq.currentKbId';

  const refreshKb = useCallback(async (kbId: string) => {
    try {
      const res = await fetch(`/api/kb?kbId=${encodeURIComponent(kbId)}`);
      const data = (await res.json()) as { docs?: KbDocMeta[] };
      setDocs(data.docs ?? []);
    } catch {
      setDocs([]);
    }
    // 同时刷新 per-KB 配置：嵌入选型（配置模型弹窗只读向量化行）+ 示例问题（对话面板空态）
    try {
      const res = await fetch(
        `/api/kbs/${encodeURIComponent(kbId)}/settings`,
      );
      if (res.ok) {
        const data = (await res.json()) as Partial<KbSettings>;
        setKbEmbedding({
          endpointId: data.embedding?.endpointId ?? null,
          model: data.embedding?.model ?? '',
        });
        setKbSuggestions(
          Array.isArray(data.suggestions)
            ? data.suggestions.filter((s) => typeof s === 'string' && s.trim())
            : [],
        );
      } else {
        setKbEmbedding(null);
        setKbSuggestions([]);
      }
    } catch {
      setKbEmbedding(null);
      setKbSuggestions([]);
    }
  }, []);

  const fetchKbs = useCallback(async () => {
    setKbsLoading(true);
    try {
      const res = await fetch('/api/kbs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as KbSummary[];
      setKbs(Array.isArray(data) ? data : []);
      setKbError(null);
    } catch {
      setKbs([]);
      setKbError('知识库列表获取失败，请确认后端已启动');
    } finally {
      setKbsLoading(false);
    }
  }, []);

  /** 初始化：从 localStorage 恢复当前库 id（失效回退 default） */
  const restoreKb = useCallback(async () => {
    let saved = 'default';
    try {
      saved = window.localStorage.getItem(CURRENT_KB_KEY) ?? 'default';
    } catch {
      // 隐私模式下 localStorage 不可用，回落 default
    }
    let valid = saved || 'default';
    const ensureValid = async () => {
      try {
        const res = await fetch('/api/kbs');
        const data = (await res.json()) as KbSummary[];
        const list = Array.isArray(data) ? data : [];
        setKbs(list);
        if (list.length > 0 && !list.some((k) => k.kbId === saved)) {
          valid = 'default';
        }
      } catch {
        valid = 'default';
      }
    };
    await ensureValid();
    setCurrentKbId(valid);
    try {
      window.localStorage.setItem(CURRENT_KB_KEY, valid);
    } catch {
      // 忽略
    }
    await refreshKb(valid);
  }, [refreshKb]);

  /** 切换当前库（写 localStorage + 刷新档案柜与列表） */
  const switchKb = useCallback(
    async (kbId: string) => {
      setCurrentKbId(kbId);
      // 任务按库归属，跨库显示会误导，切库就收起队列
      setQueueOpen(false);
      try {
        window.localStorage.setItem(CURRENT_KB_KEY, kbId);
      } catch {
        // 忽略
      }
      await refreshKb(kbId);
    },
    [refreshKb],
  );

  // 队列状态只在这一处持有：KbPanel 同时渲染在桌面 aside 与 Sheet 抽屉两份，
  // hook 放进 KbPanel 会变成双份轮询 + 两个弹窗实例。
  const clip = useLinkClipTasks(currentKbId, () => refreshKb(currentKbId));

  useEffect(() => {
    void (async () => {
      const configRes = await fetch('/api/config').catch(() => null);
      if (configRes?.ok) {
        const data = (await configRes.json()) as Partial<RagConfig>;
        setConfig({
          ...DEFAULT_CONFIG,
          ...data,
          stages: { ...DEFAULT_CONFIG.stages, ...(data.stages ?? {}) },
        });
      } else {
        setConfig(DEFAULT_CONFIG);
      }
      await restoreKb();
    })();
  }, [restoreKb]);

  const updateConfig = useCallback(
    (patch: Partial<RagConfig>) => {
      let put!: Promise<void>;
      setConfig((prev) => {
        const next = {
          ...(prev ?? DEFAULT_CONFIG),
          ...patch,
        };
        put = fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        })
          .then((res) => {
            if (!res.ok) {
              setPutError(
                `配置保存失败（HTTP ${res.status}）：请确认已通过 python main.py 启动后端（端口 8000）`,
              );
            } else {
              setPutError(null);
            }
          })
          .catch(() => {
            setPutError('配置保存失败：后端未启动或网络异常，请先运行 python main.py');
          })
          .then(() => undefined);
        return next;
      });
      return put;
    },
    [],
  );

  const applyEvent = useCallback((ev: AskEvent) => {
    // 只渲染 rag 管线的帧：data / search 管线接通后各有自己的面板，
    // 让它们混进来会把别的 stage 名当成 RAG 的阶段画进追溯面板。
    if (ev.pipeline !== 'rag') return;
    if (ev.type === 'stage') {
      setTrace((prev) => {
        const base: TraceState = prev ?? { current: ev.stage };
        switch (ev.stage) {
          case 'intent':
            return {
              ...base,
              intent: ev.data.intent,
              intentDetail: ev.data,
              current: 'intent',
            };
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
    if (ev.type === 'thinking') {
      if (thinkingStartRef.current == null) thinkingStartRef.current = Date.now();
      thinkingEndRef.current = Date.now();
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            thinking: (last.thinking ?? '') + ev.text,
          };
        }
        return next;
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
            thinking: last.thinking ?? '',
            thinkingMs:
              thinkingStartRef.current != null
                ? (thinkingEndRef.current ?? thinkingStartRef.current) -
                  thinkingStartRef.current
                : undefined,
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
      thinkingStartRef.current = null;
      thinkingEndRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        // 后端自行读取 stored config，body 只传 question
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            config: {},
            kbId: currentKbIdRef.current,
            sessionId: sessionIdRef.current,
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
            pipeline: 'rag',
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

  const kbPanel = (
    <KbPanel
      docs={docs}
      currentKbId={currentKbId}
      onMutated={() => refreshKb(currentKbId)}
      clipActive={clip.activeCount}
      onSubmitClip={(url) => void clip.submit(url)}
      onOpenQueue={() => setQueueOpen(true)}
    />
  );

  return (
    <div className="flex h-dvh flex-col">
      {putError && (
        <div className="border-b border-accent/40 bg-accent/10 px-4 py-1.5 text-xs text-accent">
          {putError}
        </div>
      )}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-sidebar/80 px-3 backdrop-blur-sm lg:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BookOpenText className="size-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-serif text-sm font-semibold leading-tight">
                          Kraq · 知识库智能问答
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
                className="relative lg:hidden"
                aria-label="打开知识库"
              >
                <Archive className="size-4" />
                {clip.activeCount > 0 && (
                  <span className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 font-mono text-[9px] leading-4 text-primary-foreground">
                    {clip.activeCount}
                  </span>
                )}
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
                  <Button
                    variant="outline"
                    className="h-8 w-full font-serif text-xs"
                    onClick={() => setConfigOpen(true)}
                    disabled={streaming}
                  >
                    配置模型
                  </Button>
                  <p className="font-serif text-xs font-semibold">检索</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>最高余弦分数置信阈值</span>
                      <span className="font-mono">
                        {config.clarifyThreshold.toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.clarifyThreshold]}
                      min={0}
                      max={1}
                      step={0.02}
                      onValueChange={(v) =>
                        updateConfig({ clarifyThreshold: v[0] ?? 0.72 })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span>召回候选数</span>
                      <span className="font-mono">{config.retrieveTopK}</span>
                    </div>
                    <Slider
                      value={[config.retrieveTopK]}
                      min={2}
                      max={20}
                      step={1}
                      onValueChange={(v) => {
                        const next = v[0] ?? 10;
                        updateConfig({
                          retrieveTopK: next,
                          // 不变式：引用资料条数不得超过候选池
                          rerankTopN: Math.min(config.rerankTopN, next),
                        });
                      }}
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
                  <div className="space-y-3 border-t pt-3">
                  <p className="font-serif text-xs font-semibold">模型</p>
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
                      <span className="font-mono">{config.rerankTopN}</span>
                    </div>
                    <Slider
                      value={[config.rerankTopN]}
                      min={1}
                      max={10}
                      step={1}
                      onValueChange={(v) => {
                        const next = v[0] ?? 5;
                        updateConfig({
                          rerankTopN: next,
                          // 不变式：引用资料条数不得超过候选池
                          retrieveTopK: Math.max(config.retrieveTopK, next),
                        });
                      }}
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
        {/* 左栏自身就是小型滚动页：列表滚、底部固定，底线与中/右栏对齐 */}
        <aside className="hidden h-full min-h-0 w-72 shrink-0 border-r bg-sidebar/40 lg:flex lg:flex-col">
          <div className="border-b px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-0 w-full justify-between gap-1.5 font-serif text-xs"
              aria-label="切换知识库"
              onClick={() => {
                setKbSwitcherOpen(true);
                void fetchKbs();
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Library className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">
                  {kbs.find((k) => k.kbId === currentKbId)?.name ?? '默认知识库'}
                </span>
              </span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </div>
          {kbPanel}
        </aside>
        <main className="min-w-0 flex-1">
          <ChatPanel
            messages={messages}
            streaming={streaming}
            suggestions={kbSuggestions}
            onSend={send}
            onStop={stop}
          />
        </main>
        <aside className="hidden w-80 shrink-0 border-l bg-sidebar/40 xl:block">
          {tracePanel}
        </aside>
      </div>

      <LinkClipQueueDialog
        open={queueOpen}
        onOpenChange={setQueueOpen}
        tasks={clip.tasks}
        degraded={clip.degraded}
        kbName={kbs.find((k) => k.kbId === currentKbId)?.name ?? '默认知识库'}
        isRetried={clip.isRetried}
        onCancel={(taskId) => void clip.cancel(taskId)}
        onRetry={(task) => void clip.retry(task)}
        onDismiss={clip.dismiss}
      />

      {config && (
        <ModelConfigDialog
          open={configOpen}
          onOpenChange={setConfigOpen}
          config={config}
          onSave={updateConfig}
          kbEmbedding={kbEmbedding}
          promptSlot={
            <PromptConfigDialog
              open={promptOpen}
              onOpenChange={setPromptOpen}
            />
          }
          onOpenPrompt={() => setPromptOpen(true)}
        />
      )}
      <KbManagerDialog
        open={kbSwitcherOpen}
        onOpenChange={setKbSwitcherOpen}
        currentKbId={currentKbId}
        kbs={kbs}
        endpoints={config?.endpoints ?? []}
        loading={kbsLoading}
        actionPending={kbActionPending}
        onSelect={(kbId) => {
          void switchKb(kbId).then(() => void fetchKbs());
          setKbSwitcherOpen(false);
        }}
        onRename={async (oldKbId, newName) => {
          setKbActionPending(true);
          try {
            const res = await fetch(`/api/kbs/${encodeURIComponent(oldKbId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok || data.error) {
              throw new Error(data.error ?? `改名失败（HTTP ${res.status}）`);
            }
            await fetchKbs();
            // 当前库改名后刷新档案柜标题区（不影响 kbId）
            await refreshKb(currentKbId);
          } catch (e) {
            setKbError(e instanceof Error ? e.message : '改名失败');
            throw e;
          } finally {
            setKbActionPending(false);
          }
        }}
        onCreate={async (name, settings) => {
          setKbActionPending(true);
          try {
            const res = await fetch('/api/kbs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, ...settings }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string; kbId?: string };
            if (!res.ok || data.error) {
              throw new Error(data.error ?? `新建失败（HTTP ${res.status}）`);
            }
            await fetchKbs();
            // 新建后自动切到新库
            if (data.kbId) {
              await switchKb(data.kbId);
            }
          } catch (e) {
            setKbError(e instanceof Error ? e.message : '新建失败');
            throw e;
          } finally {
            setKbActionPending(false);
          }
        }}
        onDelete={async (kbId) => {
          setKbActionPending(true);
          try {
            const res = await fetch(`/api/kbs?kbId=${encodeURIComponent(kbId)}`, {
              method: 'DELETE',
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok || data.error) {
              throw new Error(data.error ?? `删除失败（HTTP ${res.status}）`);
            }
            await fetchKbs();
          } catch (e) {
            setKbError(e instanceof Error ? e.message : '删除失败');
            throw e;
          } finally {
            setKbActionPending(false);
          }
        }}
        onCurrentDeleted={() => switchKb('default')}
        onSaveSettings={async (kbId, patch) => {
          setKbActionPending(true);
          try {
            const res = await fetch(
              `/api/kbs/${encodeURIComponent(kbId)}/settings`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
              },
            );
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok || data.error) {
              throw new Error(data.error ?? `保存失败（HTTP ${res.status}）`);
            }
            // 示例问题就显示在对话面板空态上：改完当前库立刻回读，别让配置与界面不同步
            if (kbId === currentKbIdRef.current) await refreshKb(kbId);
          } finally {
            setKbActionPending(false);
          }
        }}
        onReembed={async (kbId, onProgress) => {
          setKbActionPending(true);
          // 只回读当前库的档案柜：非当前库的重嵌不该覆盖右侧 docs
          const syncCabinet = async () => {
            if (kbId === currentKbIdRef.current) await refreshKb(kbId);
          };
          try {
            const res = await fetch(
              `/api/kbs/${encodeURIComponent(kbId)}/reembed`,
              { method: 'POST' },
            );
            const started = (await res.json().catch(() => null)) as ReembedJob | null;
            if (!res.ok || !started) {
              throw new Error(
                started?.error ?? `重新嵌入请求失败（HTTP ${res.status}）`,
              );
            }
            // 后端分批重嵌、每批落盘：轮询进度让档案柜逐个转绿，终态失败时抛出原因
            let job: ReembedJob = started;
            onProgress?.(job);
            const deadline = Date.now() + REEMBED_POLL_TIMEOUT_MS;
            while (job.status === 'running' && Date.now() < deadline) {
              await sleep(1500);
              const st = await fetch(
                `/api/kbs/${encodeURIComponent(kbId)}/reembed`,
              ).catch(() => null);
              if (!st?.ok) break; // 后端重启丢了任务记录，以落盘状态为准
              const next = (await st.json().catch(() => null)) as
                | ReembedJob
                | null;
              if (!next) break;
              job = next;
              await syncCabinet();
              onProgress?.(job);
            }
            await syncCabinet();
            await fetchKbs();
            if (job.status === 'failed') {
              throw new Error(job.error ?? '重新嵌入失败');
            }
            if (job.status === 'running') {
              throw new Error(
                `重新嵌入仍未结束（${job.done}/${job.total}），稍后回读档案柜查看结果`,
              );
            }
          } finally {
            setKbActionPending(false);
          }
        }}
      />
      {kbError && (
        <div className="fixed bottom-4 left-1/2 z-[60] max-w-sm -translate-x-1/2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent shadow-sm">
          {kbError}
        </div>
      )}
    </div>
  );
}
