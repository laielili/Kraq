'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Library,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { ChunkingCfg, EndpointConfig, KbEmbeddingCfg, KbSettings } from '@/lib/rag/types';

/** GET /api/kbs 返回单项 */
export interface KbSummary {
  kbId: string;
  name: string;
  docCount: number;
}

const DEFAULT_KB_ID = 'default';

const DEFAULT_CHUNKING_LOCAL: ChunkingCfg = { maxChars: 600, overlap: 50 };

export type KbActionPhase =
  | 'rename'
  | 'create'
  | 'delete'
  | null;

interface SettingsTarget {
  /** 打开面板时的 kbId（改名需要旧的） */
  kbId: string;
  name: string;
  docCount: number;
}

interface ConfirmTarget {
  kbId: string;
  name: string;
}

/** 新建知识库必填的 per-KB 配置（随 POST /api/kbs body 提交） */
export interface KbCreateSettings {
  embedding: KbEmbeddingCfg;
  chunking: ChunkingCfg;
}

interface KbManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentKbId: string;
  kbs: KbSummary[];
  /** 已配置服务端点（新建/库配置的嵌入端点下拉来源） */
  endpoints: EndpointConfig[];
  /** 正在拉取 /api/kbs */
  loading: boolean;
  /** 全局操作错误 */
  actionPending: boolean;
  /** 切库（page 负责写 localStorage + 刷新档案柜） */
  onSelect: (kbId: string) => Promise<void> | void;
  /** 后端操作：改名 / 新建 / 删除 */
  onRename: (oldKbId: string, newName: string) => Promise<void>;
  onCreate: (name: string, settings: KbCreateSettings) => Promise<void>;
  onDelete: (kbId: string, name: string) => Promise<void>;
  /** 保存 per-KB 嵌入/切块（page PUT /api/kbs/{kbId}/settings） */
  onSaveSettings: (kbId: string, patch: Partial<KbSettings>) => Promise<void>;
  /** 触发该库「重新嵌入」（POST /api/kbs/{kbId}/reembed） */
  onReembed: (kbId: string) => Promise<void>;
  /** 当前库被删除后 page 需要切回 default 时调用 */
  onCurrentDeleted: () => Promise<void> | void;
}

function nameErrorMessage(name: string): string | null {
  if (!name.trim()) return '库名不能为空';
  if (name.length > 64) return '库名不能超过 64 字符';
  return null;
}

async function fetchKbSettings(kbId: string): Promise<KbSettings | null> {
  try {
    const res = await fetch(`/api/kbs/${encodeURIComponent(kbId)}/settings`);
    if (!res.ok) return null;
    const data = (await res.json()) as KbSettings;
    if (!data || typeof data !== 'object') return null;
    return {
      embedding: {
        endpointId: data.embedding?.endpointId ?? null,
        model: data.embedding?.model ?? '',
      },
      chunking: {
        maxChars: data.chunking?.maxChars ?? 600,
        overlap: data.chunking?.overlap ?? 50,
      },
    };
  } catch {
    return null;
  }
}

export function KbManagerDialog({
  open,
  onOpenChange,
  currentKbId,
  kbs,
  endpoints,
  loading,
  actionPending,
  onSelect,
  onRename,
  onCreate,
  onDelete,
  onSaveSettings,
  onReembed,
  onCurrentDeleted,
}: KbManagerDialogProps) {
  const [settingsFor, setSettingsFor] = useState<SettingsTarget | null>(null);
  const [renameName, setRenameName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newKbName, setNewKbName] = useState('');
  // 新建弹窗的 per-KB 必填配置
  const [newEmbedding, setNewEmbedding] = useState<KbEmbeddingCfg>({
    endpointId: null,
    model: '',
  });
  const [newChunking, setNewChunking] = useState<ChunkingCfg>(DEFAULT_CHUNKING_LOCAL);
  const [confirmDelete, setConfirmDelete] = useState<ConfirmTarget | null>(null);
  const [confirmReembed, setConfirmReembed] = useState<ConfirmTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reembedPending, setReembedPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  // 库配置面板数据（GET /api/kbs/{kbId}/settings）
  const [kbSettings, setKbSettings] = useState<KbSettings | null>(null);
  const [kbSettingsLoading, setKbSettingsLoading] = useState(false);
  // 逐控件草稿（一段一存）
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState('');
  const [maxCharsDraft, setMaxCharsDraft] = useState(600);
  const [overlapDraft, setOverlapDraft] = useState(50);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearchText('');
      setLocalError(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && settingsFor) {
      const t = setTimeout(() => renameInputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open, settingsFor]);

  const filtered = useMemo(() => {
    const kw = searchText.trim().toLowerCase();
    if (!kw) return kbs;
    return kbs.filter(
      (k) =>
        k.name.toLowerCase().includes(kw) ||
        k.kbId.toLowerCase().includes(kw),
    );
  }, [kbs, searchText]);

  async function runMutation(fn: () => Promise<void>) {
    if (submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await fn();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '操作失败');
      throw e instanceof Error ? e : new Error('操作失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRename() {
    if (!settingsFor) return;
    const next = renameName.trim();
    if (next === settingsFor.name) {
      setSettingsFor(null);
      return;
    }
    const nameErr = nameErrorMessage(next);
    if (nameErr) {
      setLocalError(nameErr);
      return;
    }
    await runMutation(async () => {
      await onRename(settingsFor.kbId, next);
      setSettingsFor(null);
      setRenameName('');
    }).catch(() => undefined);
  }

  async function handleCreate() {
    const name = newKbName.trim();
    const nameErr = nameErrorMessage(name);
    if (nameErr) {
      setLocalError(nameErr);
      return;
    }
    if (!newEmbedding.endpointId) {
      setLocalError('请选择向量嵌入端点');
      return;
    }
    if (!newEmbedding.model.trim()) {
      setLocalError('请填写向量嵌入模型名');
      return;
    }
    if (newChunking.overlap >= newChunking.maxChars) {
      setLocalError('相邻重叠必须小于块最大字符');
      return;
    }
    await runMutation(async () => {
      await onCreate(name, {
        embedding: newEmbedding,
        chunking: newChunking,
      });
      setNewKbName('');
      setNewEmbedding({ endpointId: null, model: '' });
      setNewChunking(DEFAULT_CHUNKING_LOCAL);
      setCreateOpen(false);
    }).catch(() => undefined);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    await runMutation(async () => {
      await onDelete(confirmDelete.kbId, confirmDelete.name);
      if (confirmDelete.kbId === currentKbId) {
        await onCurrentDeleted();
      }
      setConfirmDelete(null);
    }).catch(() => undefined);
  }

  function openSettings(kb: KbSummary) {
    setSettingsFor({ kbId: kb.kbId, name: kb.name, docCount: kb.docCount });
    setRenameName(kb.name);
    setLocalError(null);
    setKbSettings(null);
    setKbSettingsLoading(true);
    void fetchKbSettings(kb.kbId).then((s) => {
      setKbSettings(s);
      setKbSettingsLoading(false);
      setEndpointDraft(s?.embedding.endpointId ?? null);
      setModelDraft(s?.embedding.model ?? '');
      setMaxCharsDraft(s?.chunking.maxChars ?? 600);
      setOverlapDraft(s?.chunking.overlap ?? 50);
    });
  }

  async function savePatch(key: string, patch: Partial<KbSettings>) {
    if (!settingsFor) return;
    setSavingKey(key);
    setLocalError(null);
    try {
      await onSaveSettings(settingsFor.kbId, patch);
      // 保存后回读，让面板显示后端归一后的值
      const s = await fetchKbSettings(settingsFor.kbId);
      setKbSettings(s);
      if (s) {
        setEndpointDraft(s.embedding.endpointId);
        setModelDraft(s.embedding.model);
        setMaxCharsDraft(s.chunking.maxChars);
        setOverlapDraft(s.chunking.overlap);
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSavingKey(null);
    }
  }

  async function handleReembed() {
    if (!confirmReembed || reembedPending) return;
    setReembedPending(true);
    setLocalError(null);
    try {
      await onReembed(confirmReembed.kbId);
      setConfirmReembed(null);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '重新嵌入失败');
    } finally {
      setReembedPending(false);
    }
  }

  function closeDialog(openNow: boolean) {
    onOpenChange(openNow);
    if (!openNow) {
      setSettingsFor(null);
      setConfirmDelete(null);
      setConfirmReembed(null);
      setRenameName('');
      setNewKbName('');
      setNewEmbedding({ endpointId: null, model: '' });
      setNewChunking(DEFAULT_CHUNKING_LOCAL);
      setLocalError(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[80vh] w-[80vw] max-w-none max-h-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {/* 标题栏（左：标题，右：关闭按钮，仿"档案抽屉总目"） */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-sidebar/60 px-5 py-4">
            <div>
              <DialogTitle className="font-serif text-base">
                知识库 · 档案抽屉总目
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-[11px]">
                点击抽屉卡片切换检索范围；当前库的问答与档案均以此为界。
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="关闭知识库管理"
              onClick={() => closeDialog(false)}
            >
              <X className="size-4" />
            </Button>
          </div>

          {/* 工具行：搜索 + 新建 */}
          <div className="flex shrink-0 items-center gap-2 border-b bg-background/60 px-4 py-2.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="按库名检索…"
                className="h-8 bg-card pl-8 text-xs"
              />
              {searchText && (
                <button
                  type="button"
                  aria-label="清空检索"
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearchText('')}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              disabled={loading || actionPending || submitting}
              onClick={() => {
                setNewKbName('');
                setNewEmbedding({
                  endpointId: endpoints[0]?.id ?? null,
                  model: '',
                });
                setNewChunking(DEFAULT_CHUNKING_LOCAL);
                setCreateOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              新建知识库
            </Button>
          </div>
          {(actionPending || loading) && (
            <div className="flex shrink-0 items-center gap-2 border-b bg-background/60 px-4 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {loading ? '正在拉取知识库列表…' : '后端提交中…'}
            </div>
          )}
          {!loading && !actionPending && kbs.length === 0 && (
            <div className="shrink-0 border-b bg-accent/5 px-4 py-2 text-[11px] text-accent">
              未能拉取到知识库列表；请确认后端已启动后重开本窗口。
            </div>
          )}

          {/* 主体网格 */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
                正在读取档案抽屉…
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                {searchText ? '没有匹配的抽屉，请换个关键词' : '没有任何知识库，点击「新建知识库」添加'}
              </p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
                {filtered.map((kb) => {
                  const isCurrent = kb.kbId === currentKbId;
                  const isDefault = kb.kbId === DEFAULT_KB_ID;
                  return (
                    <li key={kb.kbId}>
                      <div
                        role="button"
                        tabIndex={0}
                        className={cn(
                          'group relative flex flex-col gap-2 rounded-md border bg-card px-3 py-3 shadow-none transition-all duration-150 outline-none',
                          'focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40',
                          isCurrent
                            ? 'border-primary bg-primary/10'
                            : 'hover:border-primary/40',
                        )}
                        onClick={() => {
                          if (!isCurrent && !actionPending && !submitting) {
                            void onSelect(kb.kbId);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (
                            (e.key === 'Enter' || e.key === ' ') &&
                            !isCurrent &&
                            !actionPending &&
                            !submitting
                          ) {
                            e.preventDefault();
                            void onSelect(kb.kbId);
                          }
                        }}
                      >
                        <p
                          className={cn(
                            'pr-6 font-serif text-sm leading-tight font-medium',
                            isCurrent && 'text-primary',
                          )}
                        >
                          {kb.name}
                        </p>
                        <div className="flex items-center justify-between">
                          <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <FileText className="size-3" />
                            <span className="font-mono">{kb.docCount}</span> 份资料
                          </p>
                          <button
                            type="button"
                            disabled={actionPending || submitting}
                            aria-label={`配置知识库 ${kb.name}`}
                            className="rounded-xs p-1 text-muted-foreground transition-colors hover:text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              openSettings(kb);
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <Settings className="size-4" />
                          </button>
                        </div>
                        {/* 当前库角标：档案绿实心标签，盖住右上角 */}
                        {isCurrent && (
                          <span className="pointer-events-none absolute top-0 right-0 flex items-center gap-1 rounded-bl-md rounded-tr-md bg-primary px-1.5 py-0.5 text-[9px] leading-none text-primary-foreground">
                            <Library className="size-2.5" />
                            当前库
                          </span>
                        )}
                        {!isCurrent && (
                          <span className="pointer-events-none absolute top-0 right-0 rounded-bl-md rounded-tr-md border-b border-l bg-background/80 px-1.5 py-0.5 font-mono text-[9px] leading-none text-muted-foreground">
                            {isDefault ? '系统库' : kb.kbId}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 底部错误行 */}
          {localError && (
            <div className="shrink-0 border-t bg-accent/5 px-4 py-2 text-[11px] text-accent">
              {localError}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 新建知识库弹窗（库名 + per-KB 必填配置） */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          if (!v) {
            setCreateOpen(false);
            setLocalError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto rounded-lg sm:max-w-md">
          <DialogTitle className="font-serif text-base">新建知识库</DialogTitle>
          <DialogDescription className="text-xs">
            新建后档案柜即切换到该抽屉入库；同名的抽屉会被后端拒绝。
          </DialogDescription>

          <Input
            ref={newInputRef}
            value={newKbName}
            onChange={(e) => setNewKbName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="新库名称，例如：产品说明书"
            className="h-9 bg-card text-xs"
            maxLength={64}
            autoFocus
          />

          {/* per-KB 必填：向量嵌入端点 + 模型 */}
          <div className="space-y-2.5 rounded-md border bg-sidebar/30 p-3">
            <p className="font-serif text-xs font-semibold">向量嵌入（本库专用）</p>
            <div className="space-y-1">
              <Label className="text-[10px]">嵌入端点</Label>
              <Select
                value={newEmbedding.endpointId ?? undefined}
                onValueChange={(v) =>
                  setNewEmbedding((f) => ({ ...f, endpointId: v }))
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="选择端点" />
                </SelectTrigger>
                <SelectContent>
                  {endpoints.map((ep) => (
                    <SelectItem key={ep.id} value={ep.id} className="text-xs">
                      {ep.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {endpoints.length === 0 && (
                <p className="text-[10px] text-muted-foreground">
                  尚无端点，请先在「配置模型 → 添加端点」中添加。
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-[10px]">嵌入模型名</Label>
              <Input
                value={newEmbedding.model}
                onChange={(e) =>
                  setNewEmbedding((f) => ({ ...f, model: e.target.value }))
                }
                placeholder="如 nomic-embed-text / bge-m3 / qwen3-embedding"
                className="h-8 bg-card font-mono text-xs"
              />
            </div>
          </div>

          {/* per-KB 必填：切块 */}
          <div className="space-y-2.5 rounded-md border bg-sidebar/30 p-3">
            <p className="font-serif text-xs font-semibold">切块（本库专用）</p>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span>块最大字符</span>
                <span className="font-mono">{newChunking.maxChars}</span>
              </div>
              <Slider
                value={[newChunking.maxChars]}
                min={200}
                max={2000}
                step={50}
                onValueChange={(v) =>
                  setNewChunking((f) => ({ ...f, maxChars: v[0] ?? 600 }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span>相邻重叠</span>
                <span className="font-mono">{newChunking.overlap}</span>
              </div>
              <Slider
                value={[newChunking.overlap]}
                min={0}
                max={200}
                step={10}
                onValueChange={(v) =>
                  setNewChunking((f) => ({ ...f, overlap: v[0] ?? 50 }))
                }
              />
            </div>
          </div>

          {localError && (
            <p className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent">
              {localError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={submitting}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={submitting || !newKbName.trim() || endpoints.length === 0}
              onClick={() => void handleCreate()}
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              创建
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 库配置小面板：改名 + 向量嵌入 + 切块 + 重新嵌入 + 删除 */}
      <Dialog
        open={settingsFor != null}
        onOpenChange={(v) => {
          if (!v) {
            setSettingsFor(null);
            setLocalError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] w-96 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto p-4 sm:max-w-md">
          <DialogTitle className="font-serif text-sm">
            配置 · {settingsFor?.name ?? ''}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {settingsFor
              ? `kbId：${settingsFor.kbId} · ${settingsFor.docCount} 份资料`
              : ''}
          </DialogDescription>

          <div className="space-y-1.5">
            <label htmlFor="kb-rename-input" className="font-serif text-xs font-semibold">
              改名
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="kb-rename-input"
                ref={renameInputRef}
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleRename();
                  }
                }}
                maxLength={64}
                className="h-8 bg-card text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1 text-xs"
                disabled={actionPending || submitting || !renameName.trim()}
                onClick={() => void handleRename()}
              >
                <Pencil className="size-3" />
                保存
              </Button>
            </div>
          </div>

          {/* 向量嵌入（per-KB） */}
          <div className="space-y-2 border-t pt-2.5">
            <p className="font-serif text-xs font-semibold">向量嵌入</p>
            {kbSettingsLoading || !kbSettings ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                配置读取中…
              </div>
            ) : (
              <>
                {/* 端点一段 */}
                <div className="space-y-1">
                  <Label className="text-[10px]">嵌入端点</Label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={endpointDraft ?? undefined}
                      onValueChange={(v) => setEndpointDraft(v)}
                    >
                      <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
                        <SelectValue placeholder="选择端点" />
                      </SelectTrigger>
                      <SelectContent>
                        {endpoints.map((ep) => (
                          <SelectItem key={ep.id} value={ep.id} className="text-xs">
                            {ep.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 gap-1 text-xs"
                      disabled={
                        savingKey != null ||
                        !endpointDraft ||
                        endpointDraft === kbSettings.embedding.endpointId
                      }
                      onClick={() =>
                        void savePatch('endpoint', {
                          embedding: {
                            endpointId: endpointDraft,
                            model: kbSettings.embedding.model,
                          },
                        })
                      }
                    >
                      {savingKey === 'endpoint' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pencil className="size-3" />
                      )}
                      保存
                    </Button>
                  </div>
                </div>
                {/* 模型一段 */}
                <div className="space-y-1">
                  <Label className="text-[10px]">嵌入模型名</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={modelDraft}
                      onChange={(e) => setModelDraft(e.target.value)}
                      placeholder="如 nomic-embed-text / bge-m3"
                      className="h-8 min-w-0 flex-1 bg-card font-mono text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 gap-1 text-xs"
                      disabled={
                        savingKey != null ||
                        !modelDraft.trim() ||
                        modelDraft.trim() === kbSettings.embedding.model.trim()
                      }
                      onClick={() =>
                        void savePatch('model', {
                          embedding: {
                            endpointId: kbSettings.embedding.endpointId,
                            model: modelDraft.trim(),
                          },
                        })
                      }
                    >
                      {savingKey === 'model' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pencil className="size-3" />
                      )}
                      保存
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    修改嵌入端点/模型后，本库向量将按新模型于下次提问或启动时重算。
                  </p>
                </div>
              </>
            )}
          </div>

          {/* 切块（per-KB） */}
          <div className="space-y-2 border-t pt-2.5">
            <p className="font-serif text-xs font-semibold">切块</p>
            {kbSettingsLoading || !kbSettings ? (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                配置读取中…
              </div>
            ) : (
              <>
                {/* 块最大字符一段 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span>块最大字符</span>
                    <span className="font-mono">{maxCharsDraft}</span>
                  </div>
                  <Slider
                    value={[maxCharsDraft]}
                    min={200}
                    max={2000}
                    step={50}
                    onValueChange={(v) => setMaxCharsDraft(v[0] ?? 600)}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      disabled={
                        savingKey != null ||
                        maxCharsDraft === kbSettings.chunking.maxChars
                      }
                      onClick={() =>
                        void savePatch('maxChars', {
                          chunking: {
                            maxChars: maxCharsDraft,
                            overlap: kbSettings.chunking.overlap,
                          },
                        })
                      }
                    >
                      {savingKey === 'maxChars' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pencil className="size-3" />
                      )}
                      保存
                    </Button>
                  </div>
                </div>
                {/* 相邻重叠一段 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span>相邻重叠</span>
                    <span className="font-mono">{overlapDraft}</span>
                  </div>
                  <Slider
                    value={[overlapDraft]}
                    min={0}
                    max={200}
                    step={10}
                    onValueChange={(v) => setOverlapDraft(v[0] ?? 50)}
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      disabled={
                        savingKey != null ||
                        overlapDraft === kbSettings.chunking.overlap
                      }
                      onClick={() =>
                        void savePatch('overlap', {
                          chunking: {
                            maxChars: kbSettings.chunking.maxChars,
                            overlap: overlapDraft,
                          },
                        })
                      }
                    >
                      {savingKey === 'overlap' ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Pencil className="size-3" />
                      )}
                      保存
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    仅对之后上传的新文件生效；已有档案按当时参数切块，不重切。
                  </p>
                </div>
              </>
            )}
          </div>

          {/* 重新嵌入（红色 / 二次确认） */}
          <div className="space-y-1.5 border-t pt-2.5">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full gap-1.5 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
              disabled={actionPending || submitting || reembedPending}
              onClick={() => {
                setConfirmReembed({
                  kbId: settingsFor?.kbId ?? '',
                  name: settingsFor?.name ?? '',
                });
              }}
            >
              <RefreshCw className="size-3.5" />
              重新嵌入
            </Button>
            <p className="text-[10px] text-muted-foreground">
              对本库全部档案强制重新计算向量；不重切块。
            </p>
          </div>

          <div className="space-y-1.5 border-t pt-2.5">
            <label className="font-serif text-xs font-semibold text-destructive">
              删除知识库
            </label>
            <p className="text-[10px] text-muted-foreground">
              将连同其档案与向量数据一并删除，此操作不可撤销。
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full gap-1.5 border-destructive/40 text-xs text-destructive hover:bg-destructive/10"
              disabled={
                actionPending ||
                submitting ||
                (settingsFor?.kbId ?? '') === DEFAULT_KB_ID
              }
              onClick={() => {
                setConfirmDelete({
                  kbId: settingsFor?.kbId ?? '',
                  name: settingsFor?.name ?? '',
                });
              }}
            >
              <Trash2 className="size-3.5" />
              删除该知识库
            </Button>
            {settingsFor?.kbId === DEFAULT_KB_ID && (
              <p className="text-[10px] text-accent">
                默认知识库不可删除。
              </p>
            )}
          </div>

          {localError && (
            <p className="text-[11px] text-destructive">{localError}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除二次确认 */}
      <AlertDialog
        open={confirmDelete != null}
        onOpenChange={(v) => {
          if (!v) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-serif text-base">
              <AlertTriangle className="size-4 text-accent" />
              确认删除「{confirmDelete?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              共 {kbs.find((k) => k.kbId === confirmDelete?.kbId)?.docCount ?? 0}{' '}
              份档案将被删除。向量 collection 将随之后端清理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90"
              disabled={actionPending || submitting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {(actionPending || submitting) && (
                <Loader2 className="mr-1 inline size-3.5 animate-spin" />
              )}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 重新嵌入二次确认 */}
      <AlertDialog
        open={confirmReembed != null}
        onOpenChange={(v) => {
          if (!v) setConfirmReembed(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-serif text-base">
              <AlertTriangle className="size-4 text-destructive" />
              确认重新嵌入「{confirmReembed?.name}」？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将对本库{' '}
              {kbs.find((k) => k.kbId === confirmReembed?.kbId)?.docCount ?? 0}{' '}
              份档案全部强制重新计算向量（使用本库配置的嵌入端点/模型），耗时取决于档案规模。切块不做变更。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">取消</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90"
              disabled={reembedPending}
              onClick={(e) => {
                e.preventDefault();
                void handleReembed();
              }}
            >
              {reembedPending && (
                <Loader2 className="mr-1 inline size-3.5 animate-spin" />
              )}
              确认重新嵌入
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
