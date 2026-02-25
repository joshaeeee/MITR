import { readFile } from 'node:fs/promises';
import { env } from '../src/config/env.js';
import { EmbeddingService } from '../src/services/embeddings/embedding-service.js';
import { createQdrantClient } from '../src/services/retrieval/qdrant-client.js';

interface IngestRow {
  id: string;
  title: string;
  source: string;
  passage: string;
  tradition?: string;
  language?: string;
}

const run = async (): Promise<void> => {
  const file = process.argv[2];
  if (!file) {
    throw new Error('Usage: pnpm ingest:religious <path-to-json-array>');
  }

  const raw = await readFile(file, 'utf8');
  const rows = JSON.parse(raw) as IngestRow[];
  const embeddings = new EmbeddingService();
  const qdrant = createQdrantClient();

  const passages = rows.map((r) => r.passage);
  const vectors = await embeddings.embed(passages);

  await qdrant.upsert(env.QDRANT_COLLECTION, {
    wait: true,
    points: rows.map((row, idx) => ({
      id: row.id,
      vector: vectors[idx],
      payload: {
        title: row.title,
        source: row.source,
        passage: row.passage,
        tradition: row.tradition,
        language: row.language
      }
    }))
  });

  console.log(`Ingested ${rows.length} religious passages into ${env.QDRANT_COLLECTION}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
