'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileText, FolderOpen, PenLine, Trash2, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type {
  ChunkStrategy,
  ChunkStrategySchema,
  ChunkingSchemaResp,
  EmbedJob,
  KbDocMeta,
} from '@/lib/rag/types';

interface KbPanelProps {
  docs: KbDocMeta[];
  /** 当前知识库 id，所有档案接口均带上 */
  currentKbId: string;
  onMutated: () => Promise<void>;
  /** 进行中的转存任务数：决定 [队列] 按钮是否出现（任务状态由 page.tsx 单例持有） */
  clipActive: number;
  onSubmitClip: (url: string) => void;
  onOpenQueue: () => void;
}

export function KbPanel({
  docs,
  currentKbId,
  onMutated,
  clipActive,
  onSubmitClip,
  onOpenQueue,
}: KbPanelProps) {
  const [busy, setBusy] = useState(false);
  // 点击卡片弹出的「A4 纸阅读窗」：该条笔记的标题 + 全文
  const [viewing, setViewing] = useState<KbDocMeta | null>(null);
  // 删除确认弹窗：记录待删除的文档
  const [deleting, setDeleting] = useState<KbDocMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualBody, setManualBody] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [embedMode, setEmbedMode] = useState<ChunkStrategy>('recursive');
  const [strategies, setStrategies] = useState<ChunkStrategySchema[]>([]);
  const [embedding, setEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState<EmbedJob | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const embedInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [schemaRes, settingsRes] = await Promise.all([
          fetch('/api/chunking/schema'),
          fetch(`/api/kbs/${encodeURIComponent(currentKbId)}/settings`),
        ]);
        if (!alive) return;
        if (schemaRes.ok) {
          const schema = (await schemaRes.json()) as ChunkingSchemaResp;
          if (Array.isArray(schema.strategies)) setStrategies(schema.strategies);
        }
        if (settingsRes.ok) {
          const settings = (await settingsRes.json()) as {
            chunking?: { strategy?: ChunkStrategy };
          };
          if (settings.chunking?.strategy) setEmbedMode(settings.chunking.strategy);
        }
      } catch {
        // 读取失败保持 recursive 默认值，不阻断档案操作
      }
    })();
    return () => {
      alive = false;
    };
  }, [currentKbId]);

  function submitLink() {
    const target = linkUrl.trim();
    if (!target) return;
    // 原样交给后端归一化：粘贴的常是 App 分享文案（开头还混着 `https://75` 这种假链接），
    // 在前端猜 scheme 或取第一条 http 串都会挑错
    onSubmitClip(target);
    setLinkUrl('');
    setLinkOpen(false);
    setError(null);
  }

  async function submitManual() {
    const content = manualBody.trim();
    if (!content || manualBusy) return;
    setManualBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/kb/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kbId: currentKbId,
          title: manualTitle.trim(),
          content,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? '手动录入失败');
      }
      setManualOpen(false);
      setManualTitle('');
      setManualBody('');
      await onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '手动录入失败');
    } finally {
      setManualBusy(false);
    }
  }

  async function runEmbed() {
    setEmbedding(true);
    setEmbedProgress(null);
    try {
      const res = await fetch(
        `/api/kbs/${encodeURIComponent(currentKbId)}/embed`,
        { method: 'POST' },
      );
      const started = (await res.json().catch(() => null)) as EmbedJob | null;
      if (!res.ok || !started) {
        throw new Error(started?.error ?? `嵌入请求失败（HTTP ${res.status}）`);
      }
      let job = started;
      setEmbedProgress(job);
      const deadline = Date.now() + 10 * 60 * 1000;
      while (job.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const st = await fetch(
          `/api/kbs/${encodeURIComponent(currentKbId)}/embed`,
        );
        if (!st.ok) throw new Error(`嵌入进度读取失败（HTTP ${st.status}）`);
        job = (await st.json()) as EmbedJob;
        setEmbedProgress(job);
      }
      if (job.status === 'failed') throw new Error(job.error ?? '嵌入失败');
      if (job.status === 'running') throw new Error('嵌入超时，请稍后重试');
      await onMutated();
    } finally {
      setEmbedding(false);
      setEmbedProgress(null);
    }
  }

  async function uploadFile(file: File, embedAfter: boolean) {
    if (busy || embedding) return;
    setBusy(true);
    setError(null);
    try {
      // 二进制档案（PDF/Office）不能按文本读，交给后端解析：整个文件走 multipart
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kbId', currentKbId);
      if (embedAfter) fd.append('strategy', embedMode);
      const res = await fetch('/api/kb/upload', {
        method: 'POST',
        body: fd,
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? '上传失败');
      await onMutated();
      if (embedAfter) await runEmbed();
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (embedInputRef.current) embedInputRef.current.value = '';
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kb?id=${encodeURIComponent(id)}&kbId=${encodeURIComponent(currentKbId)}`,
        {
          method: 'DELETE',
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? '删除失败');
      await onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1.5 p-3">
            {docs.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                暂无资料，请在下方添加
              </li>
            )}
            {docs.map((doc) => (
                          <li
                            key={doc.id}
                            className="group w-full max-w-full flex cursor-pointer items-start gap-2 rounded-md border bg-card px-2.5 py-2 transition-colors hover:border-primary/40"
                            onClick={() => setViewing(doc)}
                          >
                            <FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium">{doc.title}</p>
                              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span className="font-mono">{doc.content.length} 字</span>
                                {doc.embedded ? (
                                  <Badge
                                    variant="outline"
                                    className="h-3.5 px-1 font-mono text-[9px]"
                                  >
                                    已向量化
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="outline"
                                    className="h-3.5 border-accent/40 px-1 font-mono text-[9px] text-accent"
                                  >
                                    待向量化
                                  </Badge>
                                )}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleting(doc);
                              }}
                              disabled={busy}
                              aria-label={`删除 ${doc.title}`}
                              className="rounded-sm p-1 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </li>
                        ))}
          </ul>
        </ScrollArea>
        <div className="shrink-0 border-t bg-background/60 p-3">
          {linkOpen && (
            <form
              className="mb-2 flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                submitLink();
              }}
            >
              <Input
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setLinkOpen(false);
                    setLinkUrl('');
                  }
                }}
                placeholder="粘贴链接（小红书图文 / 网页 / PDF，可省 https://）"
                aria-label="要转存的链接"
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-8 w-8 shrink-0 p-0"
                disabled={!linkUrl.trim()}
                aria-label="存入档案柜"
                title="存入档案柜"
              >
                <ArrowDownToLine className="size-4" />
              </Button>
            </form>
          )}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.pdf,.docx,.pptx,.xlsx,.epub,.html,.htm,.csv,.json,.xml"
              className="hidden"
              onChange={() => {
                const file = fileInputRef.current?.files?.[0];
                if (file) void uploadFile(file, false);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-10 flex-1 gap-2 text-sm font-medium"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <FolderOpen className="size-4" />
              上传档案
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-10 w-14 gap-1 text-xs"
              onClick={() => {
                setError(null);
                setManualOpen(true);
              }}
              disabled={busy}
              aria-label="手动录入"
              title="手动录入正文"
            >
              <PenLine className="size-4" />
              录入
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-10 w-14 gap-1 text-xs"
              onClick={() => setLinkOpen((v) => !v)}
              disabled={busy}
              aria-label="链接转存"
              aria-expanded={linkOpen}
            >
              <span className="font-mono">+🔗</span>
            </Button>
            {clipActive > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-14 gap-1 text-[11px]"
                onClick={onOpenQueue}
                aria-label={`打开转存队列，${clipActive} 个进行中`}
              >
                队列
                <span className="font-mono text-accent">{clipActive}</span>
              </Button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Select
              value={embedMode}
              onValueChange={(v) => setEmbedMode(v as ChunkStrategy)}
              disabled={busy || embedding || strategies.length === 0}
            >
              <SelectTrigger className="h-9 min-w-0 flex-1 text-xs" aria-label="嵌入模式">
                <span className="shrink-0 text-muted-foreground">嵌入模式</span>
                <SelectValue placeholder="分隔符递归" />
              </SelectTrigger>
              <SelectContent>
                {strategies.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input
              ref={embedInputRef}
              type="file"
              accept=".txt,.md,.pdf,.docx,.pptx,.xlsx,.epub,.html,.htm,.csv,.json,.xml"
              className="hidden"
              onChange={() => {
                const file = embedInputRef.current?.files?.[0];
                if (file) void uploadFile(file, true);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5 text-xs"
              onClick={() => embedInputRef.current?.click()}
              disabled={busy || embedding}
              aria-label="上传并嵌入"
            >
              <Upload className="size-4" />
              嵌入
            </Button>
          </div>
          {embedding && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              正在嵌入 {embedProgress?.done ?? 0}/{embedProgress?.total ?? 0}…
            </p>
          )}
          {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
        </div>
      </div>

      {/* 手动录入：正文先规范成 Markdown，再按当前库策略切块入库 */}
      <Dialog
        open={manualOpen}
        onOpenChange={(v) => {
          if (!v && !manualBusy) {
            setManualOpen(false);
            setError(null);
          }
        }}
      >
        <DialogContent className="w-[min(620px,92vw)] sm:max-w-none">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submitManual();
            }}
          >
            <div className="space-y-1">
              <DialogTitle className="font-serif text-base">手动录入</DialogTitle>
              <DialogDescription className="text-xs leading-5">
                正文会规范成 Markdown 后留存原文，再按当前库的切块策略入库；之后换策略可重切重嵌。
              </DialogDescription>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-title" className="text-[10px]">
                标题
              </Label>
              <Input
                id="manual-title"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="留空则用「手动录入」"
                className="h-8 text-xs"
                disabled={manualBusy}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-body" className="text-[10px]">
                正文
              </Label>
              <Textarea
                id="manual-body"
                value={manualBody}
                onChange={(e) => setManualBody(e.target.value)}
                placeholder="粘贴或输入正文…"
                className="min-h-[240px] text-xs leading-6"
                disabled={manualBusy}
              />
            </div>
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setManualOpen(false);
                  setError(null);
                }}
                disabled={manualBusy}
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                className="h-8 text-xs"
                disabled={manualBusy || !manualBody.trim()}
              >
                {manualBusy ? '存入中…' : '存入档案柜'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* 笔记阅读窗：A4 竖向比例，标题 + 全文 */}
      <Dialog open={viewing != null} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="flex max-h-[82vh] w-[min(560px,92vw)] flex-col rounded-lg p-6 sm:max-w-none">
          <div className="shrink-0 space-y-1 border-b pb-3">
            <DialogTitle className="pr-6 font-serif text-base leading-snug">
              {viewing?.title || '（无标题）'}
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px]">
              {viewing
                ? viewing.createdAt.slice(0, 16).replace('T', ' ')
                : ''}
              {viewing?.embedded ? ' · 已向量化' : ' · 待向量化'}
              {viewing && viewing.hasSource === false
                ? ' · 无留存原文（重新嵌入只重嵌不重切）'
                : ''}
            </DialogDescription>
          </div>
          <ScrollArea className="min-h-0 flex-1 pr-2">
            <p className="whitespace-pre-wrap text-xs leading-6 text-foreground/90">
              {viewing?.content}
            </p>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 删除确认：确认为绿色（执行删除），取消为红色（放弃） */}
      <AlertDialog
        open={deleting != null}
        onOpenChange={(v) => !v && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-base">
              删除笔记「{deleting?.title || '（无标题）'}」？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-5">
              该笔记将从当前知识库的档案柜中移除，向量记录一并删除；此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="h-8 bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setDeleting(null)}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
              onClick={(e) => {
                e.preventDefault();
                const id = deleting?.id;
                setDeleting(null);
                if (id) void remove(id);
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}


