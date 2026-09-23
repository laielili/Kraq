"""Tests for ``classify_intent``.

The agent is expected to expose ``classify_intent(text) -> str`` returning one
of ``'FAQ'``, ``'SEARCH'``, ``'CLARIFY'``, ``'OUT_OF_SCOPE'``. The function is
not implemented yet, so the import below currently raises ``ImportError`` and
every test in this module fails at collection time. Once ``classify_intent``
is implemented in ``src/agent/intent.py`` the cases below should each pass.
"""
import pytest

from src.agent.intent import classify_intent  # noqa: F401

VALID_INTENTS = {"FAQ", "SEARCH", "CLARIFY", "OUT_OF_SCOPE"}


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # FAQ — direct factual / how-to questions the agent can answer from a
        # knowledge base.
        ("What are your business hours?", "FAQ"),
        ("How do I reset my password?", "FAQ"),
        # SEARCH — the user is asking the agent to look something up or pull
        # external resources.
        ("Find me articles about machine learning", "SEARCH"),
        ("Show me the latest Python tutorials", "SEARCH"),
        # CLARIFY — the message is too ambiguous for the agent to act on and
        # needs a follow-up question.
        ("Tell me about it", "CLARIFY"),
        ("What about that thing?", "CLARIFY"),
        # OUT_OF_SCOPE — unrelated to the agent's domain.
        ("Make me a sandwich", "OUT_OF_SCOPE"),
        ("What's the meaning of life?", "OUT_OF_SCOPE"),
    ],
    ids=[
        "faq_business_hours",
        "faq_reset_password",
        "search_ml_articles",
        "search_python_tutorials",
        "clarify_tell_me_about_it",
        "clarify_what_about_thing",
        "oos_make_sandwich",
        "oos_meaning_of_life",
    ],
)
def test_classify_intent_returns_expected_label(text, expected):
    assert classify_intent(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "What are your business hours?",
        "Find me articles about machine learning",
        "Tell me about it",
        "Make me a sandwich",
    ],
)
def test_classify_intent_always_returns_a_valid_label(text):
    """Whatever the input, the result must be one of the four intent labels."""
    assert classify_intent(text) in VALID_INTENTS
