import pytest
from src.agent.generator import QAGenerator

class DummyLLM:
    def __init__(self, response: str):
        self.response = response

    def generate(self, prompt: str) -> str:
        return self.response

def test_generator_returns_answer():
    dummy_llm = DummyLLM("根据提供的资料，机器学习是人工智能的一个分支。[1]")
    gen = QAGenerator(llm=dummy_llm)
    context = ["机器学习是人工智能的一个分支。"]
    answer = gen.generate("机器学习是什么", context)
    assert "机器学习" in answer
    assert "[1]" in answer

def test_generator_uses_template():
    # Ensure the generator loads the template and renders correctly
    dummy_llm = DummyLLM("dummy")
    gen = QAGenerator(llm=dummy_llm)  # use default template path
    context = ["测试内容"]
    answer = gen.generate("测试问题", context)
    assert answer == "dummy"