class Reranker:
    def rerank(self, query, passages, top_n):
        if not passages:
            return []
        
        # Prepare query words
        query_words = set(query.lower().split())
        
        # Score each passage by keyword overlap
        scored_passages = []
        for passage in passages:
            content = passage.get("content", "").lower()
            # Count how many query words appear in the content
            matches = sum(1 for word in query_words if word in content)
            # We'll use matches as the confidence score (higher is better)
            scored_passages.append((matches, passage))
        
        # Sort by matches descending, then by original score descending (if available) as tie-breaker
        scored_passages.sort(key=lambda x: (x[0], x[1].get("score", 0)), reverse=True)
        
        # Extract the passages in order
        ranked_passages = [passage for _, passage in scored_passages]
        
        # Return top_n
        return ranked_passages[:top_n]
