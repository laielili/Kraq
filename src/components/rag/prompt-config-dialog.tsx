'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

interface PromptPayload {
  prompt: string | null;
  defaultPrompt: string;
}

/**
 * 「提示词配置」二级弹窗（自「配置模型」顶部按钮进入）。
 * 语义：知识问答 Agent 的全局系统提示词——无论哪个知识库，生成回答都用这一份。
 * 保存 = 存为 Agent 定制提示词；重置 = 放弃定制，恢复为
 * prompts/system_kb_default.md 的默认样本（需确认）。
 */
export function PromptConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [customized, setCustomized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  /** 拉取 Agent 当前提示词 + 全局默认 */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/prompt');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PromptPayload;
      setDefaultPrompt(data.defaultPrompt ?? '');
      // 未定制时编辑框以默认样本全文为起点（保存后即成为 Agent 定制）
      setValue(data.prompt ?? data.defaultPrompt ?? '');
      setCustomized(Boolean(data.prompt));
    } catch {
      setError('提示词获取失败，请确认后端已启动');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: value }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PromptPayload;
      setCustomized(Boolean(data.prompt));
      onOpenChange(false);
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  /** 重置 = PUT 空串（后端落为 null，跟随默认），并把编辑框刷回默认样本全文 */
  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setValue(defaultPrompt);
      setCustomized(false);
      setResetConfirmOpen(false);
    } catch {
      setError('重置失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="rounded-lg sm:max-w-2xl">
          <DialogTitle className="font-serif text-base">
            提示词配置（知识问答 Agent）
          </DialogTitle>
          <DialogDescription className="text-xs">
            系统提示词归属于知识问答 Agent 本身，对所有知识库统一生效
            {customized ? '（当前已定制）' : '（当前跟随默认样本）'}
            。保存后对任意知识库提问的回答生成即时生效。
          </DialogDescription>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              正在读取提示词…
            </div>
          ) : (
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="min-h-72 bg-card font-mono text-xs leading-5"
              placeholder="请输入知识问答 Agent 的系统提示词…"
              maxLength={4000}
            />
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetConfirmOpen(true)}
              disabled={loading || saving}
            >
              <RotateCcw className="size-3.5" />
              重置
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={loading || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 重置确认 */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-base">确认重置提示词？</AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-5">
              知识问答 Agent 的系统提示词将被清除，恢复为默认样本
              system_kb_default.md 的内容，对所有知识库生效。此操作立即生效，未保存的定制将丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">取消</AlertDialogCancel>
            <AlertDialogAction className="h-8 text-xs" onClick={() => void reset()}>
              确认重置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
