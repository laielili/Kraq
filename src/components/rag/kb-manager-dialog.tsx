'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Library,
  Loader2,
  Pencil,
  Plus,
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
import { cn } from '@/lib/utils';

/** GET /api/kbs 返回单项 */
export interface KbSummary {
  kbId: string;
  name: string;
  docCount: number;
}

const DEFAULT_KB_ID = 'default';

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

interface KbManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentKbId: string;
  kbs: KbSummary[];
  /** 正在拉取 /api/kbs */
  loading: boolean;
  /** 全局操作错误（已有，如工具栏已渲染 sadd 报错时不再重复渲染） */
  actionPending: boolean;
  /** 切库（page 负责写 localStorage + 刷新档案柜） */
  onSelect: (kbId: string) => Promise<void> | void;
  /** 后端操作：改名 / 新建 / 删除（DELETE 的 shouldDeleteCollection 先由确认框capture到 list 里） */
  onRename: (oldKbId: string, newName: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onDelete: (kbId: string, name: string) => Promise<void>;
  /** 当前库被删除后 page 需要切回 default 时调用 */
  onCurrentDeleted: () => Promise<void> | void;
}

function nameErrorMessage(name: string): string | null {
  if (!name.trim()) return '库名不能为空';
  if (name.length > 64) return '库名不能超过 64 字符';
  return null;
}

export function KbManagerDialog({
  open,
  onOpenChange,
  currentKbId,
  kbs,
  loading,
  actionPending,
  onSelect,
  onRename,
  onCreate,
  onDelete,
  onCurrentDeleted,
}: KbManagerDialogProps) {
  const [settingsFor, setSettingsFor] = useState<SettingsTarget | null>(null);
  const [renameName, setRenameName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newKbName, setNewKbName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<ConfirmTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
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
    await runMutation(async () => {
      await onCreate(name);
      setNewKbName('');
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
  }

  function closeDialog(openNow: boolean) {
    onOpenChange(openNow);
    if (!openNow) {
      setSettingsFor(null);
      setConfirmDelete(null);
      setRenameName('');
      setNewKbName('');
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

      {/* 新建知识库弹窗 */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          if (!v) {
            setCreateOpen(false);
            setLocalError(null);
          }
        }}
      >
        <DialogContent className="rounded-lg sm:max-w-sm">
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
              disabled={submitting || !newKbName.trim()}
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

      {/* 配置小面板：改名 + 删除（不含向量存储方式） */}
      <Dialog
        open={settingsFor != null}
        onOpenChange={(v) => {
          if (!v) {
            setSettingsFor(null);
            setLocalError(null);
          }
        }}
      >
        <DialogContent className="w-80 max-w-[calc(100vw-2rem)] gap-3 p-4 sm:max-w-sm">
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

    </>
  );
}
