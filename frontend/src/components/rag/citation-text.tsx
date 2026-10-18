'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';

interface CiteSource {
  id: string;
  title: string;
  content: string;
}

interface CitationTextProps {
  text: string;
  sources: CiteSource[];
}

type Part = { kind: 'text'; value: string } | { kind: 'cite'; n: number };

/** 把 [1] 这类引用编号切出来，其余文本按 markdown 原样交给渲染器。 */
function parseParts(text: string): Part[] {
  const parts: Part[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ kind: 'text', value: text.slice(last, idx) });
    parts.push({ kind: 'cite', n: Number.parseInt(m[1] ?? '0', 10) });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

function CiteMark({ n, source }: { n: number; source?: CiteSource }) {
  return (
    <HoverCard openDelay={80} closeDelay={60}>
      <HoverCardTrigger asChild>
        <sup
          className={`ml-0.5 inline-flex h-4 min-w-4 cursor-default items-center justify-center rounded-[3px] px-1 font-mono text-[10px] font-medium leading-none ${
            source
              ? 'bg-accent text-accent-foreground'
              : 'bg-muted text-muted-foreground line-through'
          }`}
        >
          {n}
        </sup>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        {source ? (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-accent px-1 font-mono text-[10px] text-accent-foreground">
                {n}
              </span>
              {source.title}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {source.content}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            引用 [{n}] 未命中任何资料
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** 把 React 子节点拍平成字符串（段落里的 [n] 通常是纯文本节点）。
 * react-markdown 的 children 类型里带 Promise 等异类，只取 string/array/元素。 */
function flattenChildren(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenChildren).join('');
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return flattenChildren(props?.children);
  }
  return '';
}

/** markdown 行内文本中的引用标记（[n] 出现在段落/列表项/加粗文本里时接住） */
function InlineCites({
  children,
  sources,
}: {
  children?: React.ReactNode;
  sources: CiteSource[];
}) {
  const text = flattenChildren(children);
  if (!text || !text.includes('[') || !/\[\d+\]/.test(text)) {
    return <>{children}</>;
  }
  const parts = parseParts(text);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <span key={i}>{part.value}</span>
        ) : (
          <CiteMark key={i} n={part.n} source={sources[part.n - 1]} />
        ),
      )}
    </>
  );
}

const withCites = (sources: CiteSource[]) =>
  ({
    p: ({ children }) => (
      <p>
        <InlineCites sources={sources}>{children}</InlineCites>
      </p>
    ),
    li: ({ children }) => (
      <li>
        <InlineCites sources={sources}>{children}</InlineCites>
      </li>
    ),
    // 引用可能出现在加粗文字内部
    strong: ({ children }) => (
      <strong>
        <InlineCites sources={sources}>{children}</InlineCites>
      </strong>
    ),
  }) as Components;

const MarkdownMemo = memo(function MarkdownBlock({
  text,
  sources,
}: {
  text: string;
  sources: CiteSource[];
}) {
  return (
    <div className="min-w-0 space-y-2 text-sm leading-7 [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:font-serif [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-serif [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:text-foreground/90 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-xs [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown components={withCites(sources)}>{text}</ReactMarkdown>
    </div>
  );
});

export function CitationText({ text, sources }: CitationTextProps) {
  return <MarkdownMemo text={text} sources={sources} />;
}
