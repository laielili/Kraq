import pytest
from src.agent.validator import AnswerValidator

def test_validator_passes_when_citations_match():
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。[1]"
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == True

def test_validator_fails_when_missing_citation():
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。"  # no citation
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == False

def test_validator_fails_when_citation_out_of_range():
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。[2]"  # only one context item
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == False

def test_validator_fails_when_non_numeric_citation():
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。[a]"
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == False

def test_validator_hallucination_heuristic():
    validator = AnswerValidator()
    # answer length > 2 * total context length -> should fail
    context = ["短"]
    answer = "这是一个非常长的答案，远超过上下文长度的两倍，这样就触发了幻觉启发式检测。"
    # compute lengths
    total_context_len = sum(len(c) for c in context)
    if len(answer) > total_context_len * 2:
        assert validator.validate(answer, context) == False
    else:
        # if condition not met, we just skip; but we can still test that it passes
        assert validator.validate(answer, context) == True