import pytest
from src.agent.reranker import Reranker

def test_reranker_heuristic():
    reranker = Reranker()
    query = "machine learning models"
    passages = [
        {"content": "Machine learning is a subset of artificial intelligence.", "score": 0.8},
        {"content": "Deep learning models are used for image recognition.", "score": 0.7},
        {"content": "The quick brown fox jumps over the lazy dog.", "score": 0.5},
    ]
    # Rerank with top_n=2
    reranked = reranker.rerank(query, passages, top_n=2)
    # We expect the first two passages to be ranked higher because they contain more query words
    # Query words: ['machine', 'learning', 'models']
    # Passage 0: contains 'machine', 'learning' -> 2 matches
    # Passage 1: contains 'learning', 'models' -> 2 matches
    # Passage 2: 0 matches
    # So the first two should be in the top 2, but we need to see the order.
    # Since both have 2 matches, we might break ties by original score or length? We'll just check that the first two are the ones with matches.
    # We'll check that the reranked list contains the two passages with matches (any order) and that the third is not present.
    assert len(reranked) == 2
    # Check that the two passages with matches are in the reranked list
    reranked_contents = {p['content'] for p in reranked}
    expected_contents = {
        "Machine learning is a subset of artificial intelligence.",
        "Deep learning models are used for image recognition."
    }
    assert reranked_contents == expected_contents

def test_reranker_top_n():
    reranker = Reranker()
    query = "test"
    passages = [
        {"content": "test one", "score": 0.1},
        {"content": "test two", "score": 0.2},
        {"content": "test three", "score": 0.3},
        {"content": "no match", "score": 0.4},
    ]
    reranked = reranker.rerank(query, passages, top_n=2)
    assert len(reranked) == 2
    # All three with 'test' should be ranked higher than the one without.
    # We expect the top 2 to be two of the three with 'test'
    reranked_contents = {p['content'] for p in reranked}
    assert "no match" not in reranked_contents
    # And that we have two of the three test passages
    assert len(reranked_contents & {"test one", "test two", "test three"}) == 2

if __name__ == "__main__":
    pytest.main([__file__])
