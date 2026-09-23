import pytest
from src.agent.retriever_vector import VectorRetriever

def test_vector_retriever_basic():
    # Sample documents
    documents = [
        "The quick brown fox jumps over the lazy dog.",
        "A fast brown fox leaps over a sleepy dog.",
        "The quick brown fox is quick.",
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
        "Practicing BM25 retrieval algorithm."
    ]
    
    retriever = VectorRetriever()
    retriever.add_documents(documents)
    
    # Query for terms that should match the first three documents
    results = retriever.retrieve("quick fox", top_k=5)
    
    # We expect at least one result
    assert len(results) > 0
    
    # The first result should be a string and score a float
    assert isinstance(results[0][0], str)
    assert isinstance(results[0][1], float)
