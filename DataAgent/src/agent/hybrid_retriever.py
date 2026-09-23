from typing import List, Tuple


class HybridRetriever:
    def __init__(self, bm25_retriever, vector_retriever, weight_bm25: float = 0.5, weight_vector: float = 0.5):
        """
        Initialize the hybrid retriever.

        Args:
            bm25_retriever: An instance of BM25Retriever.
            vector_retriever: An instance of VectorRetriever.
            weight_bm25: Weight for BM25 scores (default 0.5).
            weight_vector: Weight for vector scores (default 0.5).
        """
        self.bm25 = bm25_retriever
        self.vector = vector_retriever
        self.weight_bm25 = weight_bm25
        self.weight_vector = weight_vector
        self.documents = []

    def add_documents(self, documents: List[str]):
        """
        Add documents to both retrievers.

        Args:
            documents: List of document strings.
        """
        self.documents = documents
        self.bm25.add_documents(documents)
        self.vector.add_documents(documents)

    def retrieve(self, query: str, top_k: int = 5) -> List[Tuple[str, float]]:
        """
        Retrieve documents using weighted reciprocal rank fusion (RRF).

        Args:
            query: The search query.
            top_k: Number of top results to return.

        Returns:
            List of tuples (document, fused_score) sorted by score descending.
        """
        # Get results from both retrievers (we fetch more to have room for fusion)
        bm25_results = self.bm25.retrieve(query, top_k=top_k * 2)
        vector_results = self.vector.retrieve(query, top_k=top_k * 2)

        # RRF parameter
        k_rrf = 60
        scores = {}

        # Process BM25 results
        for rank, (doc, _) in enumerate(bm25_results, start=1):
            if doc not in scores:
                scores[doc] = 0.0
            scores[doc] += self.weight_bm25 * (1.0 / (k_rrf + rank))

        # Process vector results
        for rank, (doc, _) in enumerate(vector_results, start=1):
            if doc not in scores:
                scores[doc] = 0.0
            scores[doc] += self.weight_vector * (1.0 / (k_rrf + rank))

        # Sort by score descending
        sorted_results = sorted(scores.items(), key=lambda x: x[1], reverse=True)

        # Return top_k
        return sorted_results[:top_k]