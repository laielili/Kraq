'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  List,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  EndpointConfig,
  EndpointProtocol,
  RagConfig,
  StageKey,
} from '@/lib/rag/types';

interface ModelConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: RagConfig;
  /** page 负责本地合并 + PUT；返回 Promise 时弹窗可等待保存完成（测试连接前） */
  onSave: (patch: Partial<RagConfig>) => void | Promise<void>;
  /** 提示词配置二级弹窗元素（page 组装好 open/onOpenChange/kbId 后传入） */
  promptSlot?: ReactNode;
  /** 「提示词配置」按钮点击 → 通知 page 打开二级弹窗 */
  onOpenPrompt?: () => void;
}

interface EndpointFormState {
  editingId: string | null; // null = 新增
  name: string;
  protocol: EndpointProtocol;
  baseUrl: string;
  apiKey: string;
}

interface TestStatus {
  state: 'idle' | 'testing' | 'ok' | 'fail';
  message: string;
}

interface ModelEntry {
  endpointId: string;
  models?: string[];
  error?: string;
}

/** 后端 /api/models 返回数组；兼容 {models:[...]} 信封形态 */
function parseModelsResponse(data: unknown): ModelEntry[] {
  if (Array.isArray(data)) return data as ModelEntry[];
  const models = (data as { models?: ModelEntry[] } | null)?.models;
  return Array.isArray(models) ? models : [];
}

const EMPTY_FORM: EndpointFormState = {
  editingId: null,
  name: '',
  protocol: 'ollama',
  baseUrl: '',
  apiKey: '',
};

const DEFAULT_ENDPOINT_FORM: EndpointFormState = {
  editingId: null,
  name: 'Ollama',
  protocol: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
};

const STAGES: Array<{ key: StageKey; label: string; hint: string }> = [
  { key: 'intent', label: '意图识别', hint: '如 qwen3:4b / deepseek-chat' },
  { key: 'embedding', label: '向量化', hint: '如 nomic-embed-text / bge-m3' },
  { key: 'rerank', label: '重排', hint: 'Ollama 不支持；用 llama.cpp /v1/rerank 服务' },
  { key: 'generate', label: '生成', hint: '如 qwen3:8b / deepseek-chat' },
  { key: 'validate', label: '校验', hint: '如 qwen3:8b / deepseek-chat' },
];

function uid(): string {
  return `ep-${Math.random().toString(36).slice(2, 10)}`;
}

const IDLE_STATUS: TestStatus = { state: 'idle', message: '' };

export function ModelConfigDialog({
  open,
  onOpenChange,
  config,
  onSave,
  promptSlot,
  onOpenPrompt,
}: ModelConfigDialogProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<EndpointFormState>(EMPTY_FORM);
  const [testStatus, setTestStatus] = useState<TestStatus>(IDLE_STATUS);
  // endpointId -> 模型列表（GET /api/models 缓存，用于 datalist 建议）
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});

  const endpoints = config.endpoints ?? [];

  const fetchModelsAll = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      const data = parseModelsResponse(await res.json());
      const map: Record<string, string[]> = {};
      for (const m of data) {
        if (!m.error && m.models) map[m.endpointId] = m.models;
      }
      setModelOptions((prev) => ({ ...prev, ...map }));
    } catch {
      // 静默退化：datalist 无建议，仅纯输入
    }
  }, []);

  // 模型名输入防抖：逐键 PUT 会竞态乱序，停顿 500ms 再落盘
  const [modelDraft, setModelDraft] = useState<Partial<Record<StageKey, string>>>({});
  const debounceRef = useRef<Map<StageKey, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (open) {
      void fetchModelsAll();
    } else {
      setFormOpen(false);
      setForm(EMPTY_FORM);
      setTestStatus(IDLE_STATUS);
      setModelDraft({});
    }
  }, [open, fetchModelsAll]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setTestStatus(IDLE_STATUS);
  }, []);

  const startAdd = useCallback(() => {
    setForm(endpoints.length === 0 ? DEFAULT_ENDPOINT_FORM : EMPTY_FORM);
    setTestStatus(IDLE_STATUS);
    setFormOpen(true);
  }, [endpoints.length]);

  const startEdit = useCallback(
    (ep: EndpointConfig) => {
      setForm({
        editingId: ep.id,
        name: ep.name,
        protocol: ep.protocol,
        baseUrl: ep.baseUrl,
        apiKey: '',
      });
      setTestStatus(IDLE_STATUS);
      setFormOpen(true);
    },
    [],
  );

  // 测试连接：两级校验——端点可达性 + 该端点已配置的模型名是否在清单里
  const runTest = useCallback(
    async (id: string) => {
      setTestStatus({ state: 'testing', message: '正在测试连接…' });
      try {
        const res = await fetch('/api/models');
        const data = parseModelsResponse(await res.json());
        const entry = data.find((m) => m.endpointId === id);
        if (!entry) {
          setTestStatus({
            state: 'fail',
            message: '后端未返回该端点的结果（可能刚保存，请重试）',
          });
          return;
        }
        if (entry.error) {
          setTestStatus({ state: 'fail', message: entry.error });
          return;
        }
        const list = entry.models ?? [];
        setModelOptions((prev) => ({ ...prev, [id]: list }));
        if (list.length === 0) {
          setTestStatus({
            state: 'fail',
            message: '端点可达，但未返回任何模型',
          });
          return;
        }
        // 该端点被哪些阶段引用、模型名是否都在清单里
        const usedModels = [
          ...new Set(
            Object.values(config.stages)
              .filter((s) => s.endpointId === id && s.model.trim())
              .map((s) => s.model.trim()),
          ),
        ];
        const missing = usedModels.filter((m) => !list.includes(m));
        if (missing.length > 0) {
          setTestStatus({
            state: 'fail',
            message: `端点可达（${list.length} 个模型），但流程选型中的 ${missing.join('、')} 不在清单里，请核对模型名`,
          });
          return;
        }
        setTestStatus({
          state: 'ok',
          message: usedModels.length
            ? `✓ 连接成功，${list.length} 个模型，已配置模型均在列`
            : `✓ 连接成功，${list.length} 个模型`,
        });
      } catch {
        setTestStatus({ state: 'fail', message: '无法获取模型列表（后端未响应）' });
      }
    },
    [config.stages],
  );

  const saveEndpoint = useCallback(
    async (thenTest: boolean) => {
      const editing = form.editingId;
      const id = editing ?? uid();
      const keyFilled = Boolean(form.apiKey.trim());
      const old = editing
        ? endpoints.find((e) => e.id === editing)
        : undefined;
      const next: EndpointConfig = {
        id,
        name: form.name.trim() || '未命名端点',
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        // 留空不修改已存 Key：编辑已有端点时传 null（后端保留旧值）；新增端点传空串
        apiKey: keyFilled ? form.apiKey.trim() : old ? null : '',
        hasKey: old ? (keyFilled ? true : Boolean(old.hasKey)) : keyFilled,
      };
      const nextEndpoints = editing
        ? endpoints.map((e) => (e.id === editing ? next : e))
        : [...endpoints, next];
      setFormOpen(false);
      setForm(EMPTY_FORM);
      await Promise.resolve(onSave({ endpoints: nextEndpoints }));
      if (thenTest) {
        await runTest(id);
      }
    },
    [form, endpoints, onSave, runTest],
  );

  // 拉取某端点的模型列表（缓存到 modelOptions，供阶段行下拉使用）
  const refreshEndpointModels = useCallback(async (id: string) => {
    setTestStatus({ state: 'testing', message: '正在获取模型列表…' });
    try {
      const res = await fetch('/api/models');
      const data = parseModelsResponse(await res.json());
      const entry = data.find((m) => m.endpointId === id);
      if (entry?.error) {
        setTestStatus({ state: 'fail', message: entry.error });
        return;
      }
      if (!entry) {
        setTestStatus({
          state: 'fail',
          message: '后端未返回该端点的结果（可能刚保存，请重试）',
        });
        return;
      }
      const list = entry.models ?? [];
      setModelOptions((prev) => ({ ...prev, [id]: list }));
      setTestStatus({
        state: list.length > 0 ? 'ok' : 'fail',
        message:
          list.length > 0
            ? `✓ 连接成功，${list.length} 个模型`
            : '端点返回 0 个模型',
      });
    } catch {
      setTestStatus({ state: 'fail', message: '无法获取模型列表（后端未响应）' });
    }
  }, []);

  const removeEndpoint = useCallback(
    (id: string) => {
      onSave({
        endpoints: endpoints.filter((e) => e.id !== id),
        stages: Object.fromEntries(
          Object.entries(config.stages).map(([k, v]) => [
            k,
            v.endpointId === id ? { ...v, endpointId: null } : v,
          ]),
        ) as RagConfig['stages'],
      });
    },
    [config.stages, endpoints, onSave],
  );

  const setStage = useCallback(
    (
      key: StageKey,
      patch: Partial<{
        endpointId: string | null;
        model: string;
      }>,
    ) => {
      const cfg = config.stages[key];
      onSave({
        stages: {
          ...config.stages,
          [key]: { ...cfg, ...patch },
        },
      });
    },
    [config.stages, onSave],
  );

  const setStageModel = useCallback(
    (key: StageKey, value: string) => {
      setModelDraft((prev) => ({ ...prev, [key]: value }));
      const timers = debounceRef.current;
      const prevTimer = timers.get(key);
      if (prevTimer) clearTimeout(prevTimer);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setModelDraft((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
          setStage(key, { model: value });
        }, 500),
      );
    },
    [setStage],
  );

  useEffect(
    () => () => {
      for (const t of debounceRef.current.values()) clearTimeout(t);
    },
    [],
  );

  const modelsFor = (endpointId: string | null): string[] =>
    endpointId ? (modelOptions[endpointId] ?? []) : [];

  const configuredCount = STAGES.filter(
    (s) =>
      config.stages[s.key]?.endpointId &&
      config.stages[s.key]?.model?.trim() !== '',
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-lg sm:max-w-2xl">
        <DialogTitle className="font-serif text-base">配置模型</DialogTitle>
        <DialogDescription className="text-xs">
          为 RAG 五阶段流水线选择服务端点与模型，改动即时保存。
        </DialogDescription>

        {/* 顶部：提示词配置入口（知识问答 Agent 全局系统提示词） */}
        {promptSlot && onOpenPrompt && (
          <div className="flex justify-end border-b pb-2">
            <Button variant="outline" size="sm" onClick={onOpenPrompt}>
              <Pencil className="size-3.5" />
              提示词配置
            </Button>
          </div>
        )}

        {/* 服务端点区 */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-serif text-xs font-semibold">服务端点</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={startAdd}
            >
              <Plus className="size-3" />
              添加端点
            </Button>
          </div>

          {endpoints.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              尚未配置服务端点，请点击「添加端点」。首次使用会预填「Ollama」。
            </p>
          )}

          <ul className="space-y-1.5">
            {endpoints.map((ep) => (
              <li
                key={ep.id}
                className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{ep.name}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {ep.baseUrl}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 px-1 font-mono text-[9px]"
                >
                  {ep.protocol === 'ollama'
                    ? 'Ollama'
                    : ep.protocol === 'llamacpp'
                      ? 'llama.cpp'
                      : 'OpenAI API'}
                </Badge>
                <Badge
                  variant="outline"
                  className={`h-4 shrink-0 px-1 font-mono text-[9px] ${
                    ep.hasKey
                      ? 'border-primary/40 text-primary'
                      : 'text-muted-foreground'
                  }`}
                >
                  {ep.hasKey
                    ? '已有密钥'
                    : ep.protocol === 'openai'
                      ? '无密钥'
                      : '无需密钥'}
                </Badge>
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => void refreshEndpointModels(ep.id)}
                    aria-label={`获取 ${ep.name} 的模型列表`}
                    title="获取模型列表"
                    className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                  >
                    <List className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(ep)}
                    aria-label={`编辑 ${ep.name}`}
                    className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeEndpoint(ep.id)}
                    aria-label={`删除 ${ep.name}`}
                    className="rounded-sm p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {/* 行内编辑表单 */}
          {formOpen && (
            <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
              <p className="text-[11px] font-medium">
                {form.editingId ? '编辑端点' : '新增端点'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[10px]">名称</Label>
                  <Input
                    value={form.name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder={
                      form.protocol === 'openai' ? '' : '如：Ollama'
                    }
                    className="h-7 bg-card text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">协议</Label>
                  <Select
                    value={form.protocol}
                    onValueChange={(v: EndpointProtocol) =>
                      setForm((f) => ({ ...f, protocol: v }))
                    }
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ollama" className="text-xs">
                        Ollama
                      </SelectItem>
                      <SelectItem value="openai" className="text-xs">
                        OpenAI API
                      </SelectItem>
                      <SelectItem value="llamacpp" className="text-xs">
                        llama.cpp
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[10px]">Base URL</Label>
                  <Input
                    value={form.baseUrl}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, baseUrl: e.target.value }))
                    }
                    placeholder={
                      form.protocol === 'ollama'
                        ? 'http://localhost:11434'
                        : form.protocol === 'llamacpp'
                          ? 'http://localhost:8081（llama-server --reranking）'
                          : 'https://api.example.com/v1'
                    }
                    className="h-7 bg-card font-mono text-xs"
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-[10px]">API Key</Label>
                  <Input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, apiKey: e.target.value }))
                    }
                    placeholder="留空不修改"
                    className="h-7 bg-card text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!form.baseUrl.trim()}
                  onClick={() => void saveEndpoint(false)}
                >
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={!form.baseUrl.trim()}
                  onClick={() => void saveEndpoint(true)}
                >
                  测试并保存
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={closeForm}
                >
                  <X className="size-3" />
                  取消
                </Button>
              </div>
            </div>
          )}

          {testStatus.state !== 'idle' && (
            <p
              className={`flex items-center gap-1 text-[11px] ${
                testStatus.state === 'ok'
                  ? 'text-primary'
                  : testStatus.state === 'fail'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }`}
            >
              {testStatus.state === 'testing' && (
                <Loader2 className="size-3 animate-spin" />
              )}
              {testStatus.state === 'ok' && <Check className="size-3" />}
              {testStatus.message}
            </p>
          )}
        </section>

        {/* 流程选型区 */}
        <section className="space-y-2">
          <p className="font-serif text-xs font-semibold">流程选型</p>
          {endpoints.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              先在上方添加服务端点，再为各阶段选择模型。
            </p>
          )}
          <div className="space-y-1.5">
            {STAGES.map((stage) => {
              const cfg = config.stages[stage.key] ?? {
                endpointId: null,
                model: '',
              };
              return (
                <div
                  key={stage.key}
                  className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5"
                >
                  <span className="w-24 shrink-0 text-xs font-medium">
                    {stage.label}
                  </span>
                  {endpoints.length === 0 ? (
                    <span className="flex-1 text-[11px] text-muted-foreground">
                      先在上方添加服务端点
                    </span>
                  ) : (
                    <>
                      <Select
                        value={cfg.endpointId ?? undefined}
                        onValueChange={(v) =>
                          setStage(stage.key, { endpointId: v })
                        }
                      >
                        <SelectTrigger className="h-7 w-28 shrink-0 text-xs">
                          <SelectValue placeholder="端点" />
                        </SelectTrigger>
                        <SelectContent>
                          {endpoints.map((ep) => (
                            <SelectItem
                              key={ep.id}
                              value={ep.id}
                              className="text-xs"
                            >
                              {ep.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="min-w-0 flex-1">
                        <Input
                          value={modelDraft[stage.key] ?? cfg.model}
                          onChange={(e) =>
                            setStageModel(stage.key, e.target.value)
                          }
                          list={`model-options-${stage.key}`}
                          placeholder={
                            config.endpoints?.find(
                              (ep) => ep.id === cfg.endpointId,
                            )?.protocol === 'openai'
                              ? 'deepseek/deepseek-v4.1-flash'
                              : stage.hint
                          }
                          className="h-7 bg-background/60 font-mono text-xs"
                        />
                        {/* 已拉取的模型清单以 datalist 建议形式辅助输入，可自由键入任意模型名 */}
                        <datalist id={`model-options-${stage.key}`}>
                          {modelsFor(cfg.endpointId).map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </div>
                      <span className="hidden w-28 shrink-0 text-right text-[10px] leading-3 text-muted-foreground sm:block">
                        {stage.hint}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            已配置 {configuredCount}/5 个阶段
            {configuredCount < 5
              ? '；未配置完整时，对应阶段无法执行，可在上方补齐。'
              : '。'}
          </p>
        </section>

        {/* 检索参数区 */}
        <section className="space-y-2">
          <p className="font-serif text-xs font-semibold">检索参数</p>
          {(
            [
              {
                key: 'retrieveTopK' as const,
                label: '召回候选数',
                hint: 'BM25 / 向量各取前 K（recall_k）',
                min: 2,
                max: 20,
                step: 1,
              },
              {
                key: 'rerankTopN' as const,
                label: '重排保留数',
                hint: '重排后进入生成的条数（top_n）',
                min: 1,
                max: 10,
                step: 1,
              },
            ]
          ).map((p) => {
            const value = config[p.key];
            return (
              <div
                key={p.key}
                className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5"
              >
                <span className="w-16 shrink-0 text-xs font-medium">
                  {p.label}
                </span>
                <Slider
                  value={[value]}
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  onValueChange={(v) => {
                    const next = v[0] ?? value;
                    // 不变式：重排保留数不得超过候选池
                    const patch: Partial<RagConfig> = { [p.key]: next };
                    if (
                      p.key === 'retrieveTopK' &&
                      config.rerankTopN > next
                    ) {
                      patch.rerankTopN = next;
                    }
                    if (
                      p.key === 'rerankTopN' &&
                      next > config.retrieveTopK
                    ) {
                      patch.retrieveTopK = next;
                    }
                    onSave(patch);
                  }}
                  className="h-4 flex-1"
                />
                <span className="w-7 shrink-0 text-right font-mono text-xs">
                  {value}
                </span>
                <span className="hidden w-32 shrink-0 text-right text-[10px] leading-3 text-muted-foreground sm:block">
                  {p.hint}
                </span>
              </div>
            );
          })}
          <p className="text-[11px] text-muted-foreground">
            召回候选 ≥ 重排保留；调整立即生效，无需重建知识库。
          </p>
        </section>

        <div className="flex justify-end">
          <Button
            size="sm"
            className="text-xs"
            onClick={() => onOpenChange(false)}
          >
            完成
          </Button>
        </div>

        {/* 提示词配置二级弹窗（slot 元素由 page 传入，自带 open/onOpenChange） */}
        {promptSlot}
      </DialogContent>
    </Dialog>
  );
}
