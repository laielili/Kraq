'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Send,
  Square,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CitationText } from './citation-text';
import type { SourceDoc } from '@/lib/rag/types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 模型思考过程（thinking tokens），随流式累积；仅思考型模型会产生 */
  thinking?: string;
  /** 思考耗时（毫秒），done 时由后端事件时间差计算 */
  thinkingMs?: number;
  sources?: SourceDoc[];
  streaming?: boolean;
  valid?: boolean | null;
  error?: boolean;
}

/** 思考过程折叠块：流式时显示"正在思考…"，结束后变为"已思考 N 秒"，点击展开/收起 */
function ThinkingBlock({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const active = msg.streaming && !msg.content;
  const seconds =
    msg.thinkingMs != null ? Math.round(msg.thinkingMs / 1000) : null;
  return (
    <div className="mb-2 border-b border-border/60 pb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {active ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Brain className="size-3.5" />
        )}
        <span>
          {active
            ? '正在思考…'
            : seconds != null
              ? `已思考 ${seconds} 秒`
              : '已思考'}
        </span>
        <ChevronRight
          className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <p className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap font-serif text-xs leading-5 text-muted-foreground">
          {msg.thinking}
        </p>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  '什么是 RAG？它解决什么问题？',
  'BM25 和向量检索各有什么优缺点？',
  '系统如何防止大模型幻觉？',
  '帮我找一下关于重排序的资料',
];

interface ChatPanelProps {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
}

export function ChatPanel({
  messages,
  streaming,
  onSend,
  onStop,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [messages]);

  function submit() {
    const q = input.trim();
    if (!q || streaming) return;
    onSend(q);
    setInput('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div ref={scrollRef} className="space-y-4 overflow-y-auto p-4 lg:p-6">
          {messages.length === 0 && (
            <div className="mx-auto max-w-md space-y-4 py-10 text-center">
              <p className="font-serif text-lg font-semibold">
                向知识库提问
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                回答基于档案柜中的资料生成，并标注引用编号；
                <br />
                右侧可查看检索与校验全过程。
              </p>
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSend(s)}
                    className="rounded-md border bg-card px-3 py-1.5 text-xs text-foreground/80 transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) =>
            msg.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-md bg-secondary px-4 py-2.5 font-serif text-sm leading-6">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div
                  className={`max-w-[92%] rounded-md border px-4 py-3 text-sm ${
                    msg.error
                      ? 'border-accent/50 bg-accent/5'
                      : 'bg-card'
                  }`}
                >
                  {msg.thinking && msg.thinking.length > 0 && (
                    <ThinkingBlock msg={msg} />
                  )}
                  {msg.content ? (
                    <CitationText text={msg.content} sources={msg.sources ?? []} />
                  ) : (
                    !msg.thinking?.length && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        正在分析问题…
                      </p>
                    )
                  )}
                  {msg.streaming && msg.content && (
                    <span className="caret" aria-hidden />
                  )}
                  {!msg.streaming && msg.valid != null && (
                    <p className="mt-2 flex items-center gap-1 border-t pt-2 text-[10px] text-muted-foreground">
                      {msg.valid ? (
                        <CheckCircle2 className="size-3 text-primary" />
                      ) : (
                        <AlertTriangle className="size-3 text-accent" />
                      )}
                      {msg.valid ? '引用校验通过' : '引用校验未通过，请以资料为准'}
                    </p>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      <div className="border-t bg-background/70 p-3 lg:p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="输入问题，Enter 发送，Shift + Enter 换行"
            className="max-h-36 min-h-11 resize-none bg-card"
            rows={1}
          />
          {streaming ? (
            <Button
              size="icon"
              variant="outline"
              className="size-11 shrink-0"
              onClick={onStop}
              aria-label="停止生成"
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0"
              onClick={submit}
              disabled={!input.trim()}
              aria-label="发送"
            >
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
