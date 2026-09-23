import type { IntentLabel } from './types';

const CLARIFY_PATTERNS: RegExp[] = [
  /\btell me about it\b/,
  /\bwhat about (?:that|this|it|those|these|them)\b/,
  /\bthat thing\b/,
  /\bthis thing\b/,
  /\babout (?:it|that|this|them)\s*[?!.]*\s*$/,
  /\byou know (?:what|which one)\b/,
  /^(那|这)(个|件|些)?(东西|事情|事)?(呢|怎么样|如何)?[?？。！!]*$/,
];

const SEARCH_PATTERNS: RegExp[] = [
  /\b(?:find|show|get|fetch|search|look up|list)\b[^.?!]*\b(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|docs?|documentation)\b/,
  /\b(?:find|show|get|fetch|search|list)\s+me\b/,
  /\b(?:latest|newest|recent|top\s+\d+)\b[^.?!]*(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|news)\b/,
  /\bsearch (?:the )?(?:web|internet|docs?)\b/,
  /(?:找|搜|检索|搜索).{0,12}(?:文章|资料|文档|论文|新闻|教程|结果|资源|视频)/,
  /(?:帮我)?(?:找一下|搜一下|查一下)/,
];

const FAQ_PATTERNS: RegExp[] = [
  /\bwhat(?:'s| is| are) your\b/,
  /\bhow (?:do|can|should|would)\s+(?:i|you|we)\b/,
  /\bwhere (?:is|are|do|can)\b[^.?!]*\byour\b/,
  /\bwhen (?:is|are|do|can)\b[^.?!]*\byour\b/,
  /\bdo you (?:support|have|offer|accept|provide)\b/,
  /\bcan i (?:cancel|upgrade|downgrade|return|refund|change|reset|delete)\b/,
  /\breset (?:my|the)\s+\w+\b/,
  /\bmy (?:account|order|password|subscription|invoice|profile|billing)\b/,
  /\bwhat is\b/,
  /\bwhat are\b/,
  /\bhow to\b/,
  /什么是|是什么/,
  /怎么|如何/,
  /为什么|为啥/,
  /是否/,
  /谁是|是谁/,
  /什么时候|何时/,
  /哪里|哪儿|何处/,
  /介绍(?:一下)?/,
];

const GROUPS: Array<[IntentLabel, RegExp[]]> = [
  ['CLARIFY', CLARIFY_PATTERNS],
  ['SEARCH', SEARCH_PATTERNS],
  ['FAQ', FAQ_PATTERNS],
];

export function classifyIntent(text: string): IntentLabel {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return 'OUT_OF_SCOPE';
  for (const [label, patterns] of GROUPS) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) return label;
    }
  }
  return 'OUT_OF_SCOPE';
}
