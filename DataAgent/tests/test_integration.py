import pytest
from src.agent.pipeline import QAAgent
from src.agent.intent import classify_intent
from src.agent.retriever_bm25 import BM25Retriever
from src.agent.retriever_vector import VectorRetriever
from src.agent.hybrid_retriever import HybridRetriever
from src.agent.reranker import Reranker
from src.agent.generator import QAGenerator
from src.agent.validator import AnswerValidator

def load_kb(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]

def test_integration_qa():
    # tiny KB
    kb = load_kb("data/kb_sample.txt")
    # Ensure we have some data; if not, add a few sentences for testing
    if not kb:
        kb = [
            "人工智能（AI）是模拟人类智能的科学。",
            "机器学习是人工智能的一个分支，通过数据训练模型实现自动学习。",
            "深度学习使用多层神经网络进行特征学习。",
            "自然语言处理让计算机理解和生成人类语言。",
        ]
    bm25 = BM25Retriever(kb)
    vec = VectorRetriever()  # use default model name
    vec.add_documents(kb)
    hybrid = HybridRetriever(bm25_retriever=bm25, vector_retriever=vec, weight_bm25=0.4, weight_vector=0.6)
    reranker = Reranker()
    class EchoLLM:
        def generate(self, prompt: str) -> str:
            # extract first sentence after "资料：" that looks like a context line
            import re
            m = re.search(r"资料：\\n(.*)", prompt, re.S)
            if m:
                first_line = m.group(1).split("\\n")[0].strip()
                return f"根据提供的资料，{first_line}[1]"
            return "未知。"
    generator = QAGenerator(llm=EchoLLM())  # use default template path
    validator = AnswerValidator()
    agent = QAAgent(
        intent_classifier=classify_intent,
        retriever=lambda q, k: hybrid.retrieve(q, top_k=k),
        reranker=reranker.rerank,
        generator=generator.generate,
        validator=validator.validate,
    )
    answer, trace = agent.ask("什么是机器学习？", top_k=2)
    assert "机器学习" in answer
    assert "[1]" in answer
    assert trace["valid"] == True