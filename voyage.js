// voyage.js — single source of truth for all Voyage AI calls.

const VOYAGE_EMBED_MODEL = "voyage-3-lite";
const VOYAGE_RERANK_MODEL = "rerank-2.5";

export async function generateVoyageEmbedding(text) {
  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: VOYAGE_EMBED_MODEL,
      input: text
    })
  });
  const data = await response.json();
  if (!data.data || !data.data[0]) {
    throw new Error(`Voyage embedding error: ${JSON.stringify(data)}`);
  }
  return data.data[0].embedding;
}

// Reranks documents against a query. Returns the raw Voyage results array
// (each: { index, document, relevance_score }), sorted by descending relevance.
// Throws on failure — caller is responsible for fallback.
export async function voyageRerank(query, documents, topK = null) {
  const body = {
    query,
    documents,
    model: VOYAGE_RERANK_MODEL
  };
  if (topK != null) body.top_k = topK;

  const response = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.results) {
    throw new Error(`Voyage rerank error: ${JSON.stringify(data)}`);
  }
  return data.results; // [{ index, document, relevance_score }], desc by score
}
