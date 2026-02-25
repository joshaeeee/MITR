import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { env } from '../src/config/env.js';
import { EmbeddingService } from '../src/services/embeddings/embedding-service.js';
import { createQdrantClient } from '../src/services/retrieval/qdrant-client.js';

interface StoryRow {
  story_id: string;
  title: string;
  tradition?: string;
  language?: string;
  region?: string;
  tone?: string;
  moral?: string;
  source_citations?: Array<{ title?: string; url?: string }>;
  narrative_text: string;
}

interface ChunkedRow {
  id: string;
  storyId: string;
  title: string;
  passage: string;
  source: string;
  language?: string;
  tradition?: string;
  region?: string;
  tone?: string;
  moral?: string;
}

const parseArgs = (): Record<string, string> => {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    throw new Error(
      'Usage: pnpm ingest:stories <translated-stories.jsonl> [--chunk-size 1200] [--chunk-overlap 150]'
    );
  }

  const out: Record<string, string> = {
    input: args[0],
    chunkSize: '1200',
    chunkOverlap: '150'
  };

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for flag ${token}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
};

const splitWithOverlap = (text: string, chunkSize: number, overlap: number): string[] => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + chunkSize, normalized.length);
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
};

const toStablePointId = (value: string): string =>
  createHash('sha1').update(value).digest('hex').slice(0, 32);

const buildSourceLabel = (row: StoryRow): string => {
  const citation = row.source_citations?.[0];
  if (citation?.title) return citation.title;
  return 'stories_curated';
};

const rowToChunks = (row: StoryRow, chunkSize: number, overlap: number): ChunkedRow[] => {
  const sections = splitWithOverlap(row.narrative_text ?? '', chunkSize, overlap);
  const source = buildSourceLabel(row);

  return sections.map((passage, idx) => {
    const id = toStablePointId(`${row.story_id}:${idx}:${passage}`);
    return {
      id,
      storyId: row.story_id,
      title: row.title,
      passage,
      source,
      language: row.language,
      tradition: row.tradition,
      region: row.region,
      tone: row.tone,
      moral: row.moral
    };
  });
};

const readJsonl = async (file: string): Promise<StoryRow[]> => {
  const rows: StoryRow[] = [];
  const rl = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as StoryRow);
  }
  return rows;
};

const run = async (): Promise<void> => {
  const args = parseArgs();
  const input = args.input;
  const chunkSize = Number(args.chunkSize);
  const chunkOverlap = Number(args.chunkOverlap);
  if (!Number.isFinite(chunkSize) || chunkSize < 200) {
    throw new Error('--chunk-size must be >= 200');
  }
  if (!Number.isFinite(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error('--chunk-overlap must be >= 0 and < chunk-size');
  }

  const rows = await readJsonl(input);
  if (rows.length === 0) {
    console.log(`No rows found in ${input}`);
    return;
  }

  const chunked = rows.flatMap((row) => rowToChunks(row, chunkSize, chunkOverlap));
  if (chunked.length === 0) {
    console.log('No chunked passages created. Nothing to ingest.');
    return;
  }

  console.log(`Embedding ${chunked.length} story chunks from ${rows.length} stories...`);
  const embeddings = new EmbeddingService();
  const vectors = await embeddings.embed(chunked.map((c) => c.passage));

  const qdrant = createQdrantClient();
  await ensureCollectionExists(qdrant, env.QDRANT_COLLECTION, vectors[0]?.length ?? 0);
  await qdrant.upsert(env.QDRANT_COLLECTION, {
    wait: true,
    points: chunked.map((chunk, idx) => ({
      id: chunk.id,
      vector: vectors[idx],
      payload: {
        kind: 'story',
        story_id: chunk.storyId,
        title: chunk.title,
        source: chunk.source,
        passage: chunk.passage,
        tradition: chunk.tradition,
        language: chunk.language,
        region: chunk.region,
        tone: chunk.tone,
        moral: chunk.moral
      }
    }))
  });

  console.log(
    `Ingested ${chunked.length} story chunks (${rows.length} stories) into ${env.QDRANT_COLLECTION}`
  );
};

const ensureCollectionExists = async (
  qdrant: ReturnType<typeof createQdrantClient>,
  collectionName: string,
  vectorSize: number
): Promise<void> => {
  if (!vectorSize || vectorSize < 1) {
    throw new Error(`Invalid vector size for collection creation: ${vectorSize}`);
  }

  try {
    await qdrant.getCollection(collectionName);
    return;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404) throw error;
  }

  await qdrant.createCollection(collectionName, {
    vectors: {
      size: vectorSize,
      distance: 'Cosine'
    }
  });
  console.log(`Created missing Qdrant collection '${collectionName}' with vector size ${vectorSize}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
