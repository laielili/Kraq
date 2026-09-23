'''Lightweight rule-based intent classifier.

Exposes :func:`classify_intent`, which maps a free-form user message to one
of four labels:

* ``'FAQ'``          — a direct factual / how-to question that the agent can
                       answer from its knowledge base (e.g. *\"What are your
                       business hours?\"*, *\"How do I reset my password?\"*).
* ``'SEARCH'``       — the user is asking the agent to look something up or
                       pull external resources (e.g. *\"Find me articles
                       about machine learning\"*).
* ``'CLARIFY'``      — the message is too ambiguous to act on and the agent
                       should ask a follow-up question (e.g. *\"Tell me about
                       it\"*, *\"What about that thing?\"*).
* ``'OUT_OF_SCOPE'`` — the message is unrelated to the agent's domain and
                       should be declined (e.g. *\"Make me a sandwich\"*).

The classifier is intentionally simple: a sequence of compiled regex
patterns evaluated in priority order. Patterns higher in the chain win over
later ones, so broad intents (``OUT_OF_SCOPE`` as the implicit fallback) are
checked last. New patterns can be appended to the relevant tuple without
touching the matching logic.
'''
from __future__ import annotations

import re
from typing import Final

__all__ = ["classify_intent", "VALID_INTENTS"]

VALID_INTENTS: Final[frozenset[str]] = frozenset(
    {"FAQ", "SEARCH", "CLARIFY", "OUT_OF_SCOPE"}
)


# ---------------------------------------------------------------------------
# Pattern groups
#
# Each tuple is checked top-to-bottom with :func:`re.search` against the
# lower-cased, stripped input. The first group that yields a match decides
# the label, so the order between groups (CLARIFY -> SEARCH -> FAQ ->
# OUT_OF_SCOPE) matters: CLARIFY patterns must run before generic FAQ
# patterns, and SEARCH patterns before FAQ ones, to avoid mis-labelling
# vague references or look-up requests as direct questions.
# ---------------------------------------------------------------------------


# Vague references / anaphora that need a follow-up question. Kept specific
# enough that legitimate \"tell me about X\" requests still fall through to
# SEARCH/FAQ.
_CLARIFY_PATTERNS: Final[tuple[str, ...]] = (
    r\"\\btell me about it\\b\",
    r\"\\bwhat about (?:that|this|it|those|these|them)\\b\",
    r\"\\bthat thing\\b\",
    r\"\\bthis thing\\b\",
    r\"\\babout (?:it|that|this|them)\\s*[?!.]*\\s*$\",
    r\"\\byou know (?:what|which one)\\b\",
)


# Requests to look something up or surface external resources.
_SEARCH_PATTERNS: Final[tuple[str, ...]] = (
    r\"\\b(?:find|show|get|fetch|search|look up|list)\\b[^.?!]*\\b(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|docs?|documentation)\\b\",
    r\"\\b(?:find|show|get|fetch|search|list)\\s+me\\b\",
    r\"\\b(?:latest|newest|recent|top\\s+\\d+)\\b[^.?!]*(?:articles?|tutorials?|posts?|videos?|results?|resources?|papers?|guides?|news)\\b\",
    r\"\\bsearch (?:the )?(?:web|internet|docs?)\\b\",
)


# First-person factual / how-to questions answerable from a knowledge base.
# Restricted to possessive \"your\" or first-person \"i/my\" so that philosophical
# or otherwise unrelated questions starting with \"what's the...\" fall through
# to OUT_OF_SCOPE.
# Extended to also match general factual questions (what is, how to, etc.) for
# a knowledge base agent.
_FAQ_PATTERNS: Final[tuple[str, ...]] = (
    r\"\\bwhat(?:'s| is| are) your\\b\",
    r\"\\bhow (?:do|can|should|would)\\s+(?:i|you|we)\\b\",
    r\"\\bwhere (?:is|are|do|can)\\b[^.?!]*\\byour\\b\",
    r\"\\bwhen (?:is|are|do|can)\\b[^.?!]*\\byour\\b\",
    r\"\\bdo you (?:support|have|offer|accept|provide)\\b\",
    r\"\\bcan i (?:cancel|upgrade|downgrade|return|refund|change|reset|delete)\\b\",
    r\"\\breset (?:my|the)\\s+\\w+\\b\",
    r\"\\bmy (?:account|order|password|subscription|invoice|profile|billing)\\b\",
    # General factual questions for knowledge base
    r\"\\bwhat is\\b\",  # Note: only leading boundary, to match \"what is ...\" etc.
    r\"\\bwhat are\\b\",  # Note: only leading boundary
    r\"\\bhow to\\b\",   # Note: only leading boundary
    r\"\\bhow\\s+to\\b\", # Note: only leading boundary
    r\"\\b是否\\b\",      # Note: only leading boundary
    r\"\\b可以\\b\",      # Note: only leading boundary
    r\"\\b为什么\\b\",    # Note: only leading boundary
    r\"\\b什么是\\b\",   # Note: only leading boundary
    r\"\\b怎么\\b\",     # Note: only leading boundary
    r\"\\b如何\\b\",     # Note: only leading boundary
    r\"\\b谁是\\b\",     # Note: only leading boundary
    r\"\\b什么时候\\b\", # Note: only leading boundary
    r\"\\b哪里\\b\",     # Note: only leading boundary
)


# Compiled regex cache — built once at import time.
_COMPILED: Final[dict[str, tuple[re.Pattern[str], ...]]] = {
    \"CLARIFY\": tuple(re.compile(p) for p in _CLARIFY_PATTERNS),
    \"SEARCH\": tuple(re.compile(p) for p in _SEARCH_PATTERNS),
    \"FAQ\": tuple(re.compile(p) for p in _FAQ_PATTERNS),
}


def classify_intent(text: str) -> str:
    \"\"\"Classify *text* into one of ``'FAQ'``, ``'SEARCH'``, ``'CLARIFY'``,
    ``'OUT_OF_SCOPE'``.

    Non-string input and empty / whitespace-only input fall back to
    ``'OUT_OF_SCOPE'`` so the function always returns a valid label.
    \"\"\"
    if not isinstance(text, str):
        return \"OUT_OF_SCOPE\"

    normalized = text.strip().lower()
    if not normalized:
        return \"OUT_OF_SCOPE\"

    for label in (\"CLARIFY\", \"SEARCH\", \"FAQ\"):
        for pattern in _COMPILED[label]:
            if pattern.search(normalized):
                return label

    return \"OUT_OF_SCOPE\"
'''