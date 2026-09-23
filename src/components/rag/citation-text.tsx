'use client';

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

export function CitationText({ text, sources }: CitationTextProps) {
  const parts = parseParts(text);

  return (
    <span className="whitespace-pre-wrap leading-7">
      {parts.map((part, i) => {
        if (part.kind === 'text') return <span key={i}>{part.value}</span>;
        const source = sources[part.n - 1];
        return (
          <HoverCard key={i} openDelay={80} closeDelay={60}>
            <HoverCardTrigger asChild>
              <sup
                className={`ml-0.5 inline-flex h-4 min-w-4 cursor-default items-center justify-center rounded-[3px] px-1 font-mono text-[10px] font-medium leading-none ${
                  source
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-muted text-muted-foreground line-through'
                }`}
              >
                {part.n}
              </sup>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-80">
              {source ? (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] bg-accent px-1 font-mono text-[10px] text-accent-foreground">
                      {part.n}
                    </span>
                    {source.title}
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {source.content}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  引用 [{part.n}] 未命中任何资料
                </p>
              )}
            </HoverCardContent>
          </HoverCard>
        );
      })}
    </span>
  );
}
