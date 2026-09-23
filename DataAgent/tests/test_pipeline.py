import pytest
from src.agent.pipeline import QAAgent

def test_pipeline_end_to_end():
    # use lightweight dummy components for fast unit test
    agent = QAAgent(
        intent_classifier=lambda q: "FAQ",
        retriever=lambda q, top_k: ["机器学习是人工智能的一个分支。"],
        reranker=lambda q, c, top_k: [(c[0], 1.0)],
        generator=lambda q, c: "机器学习是人工智能的一个分支。[1]",
        validator=lambda a, c: True
    )
    answer, trace = agent.ask("机器学习是什么", top_k=1)
    assert "机器学习" in answer
    assert trace["intent"] == "FAQ"
    assert len(trace["retrieved"]) == 1
    assert trace["valid"] == True

def test_pipeline_out_of_scope():
    agent = QAAgent(
        intent_classifier=lambda q: "OUT_OF_SCOPE",
        retriever=lambda q, top_k: [],
        reranker=lambda q, c, top_k: [],
        generator=lambda q, c: "",
        validator=lambda a, c: True
    )
    answer, trace = agent.ask("今天天气怎么样", top_k=1)
    assert answer == "抱歉，我无法回答此问题。"
    assert trace["intent"] == "OUT_OF_SCOPE"