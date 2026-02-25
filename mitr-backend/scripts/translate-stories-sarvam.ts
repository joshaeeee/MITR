import 'dotenv/config';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

interface StoryRow {
  story_id: string;
  title: string;
  language?: string;
  narrative_text: string;
  moral?: string;
  [key: string]: unknown;
}

interface TranslateResponse {
  translated_text?: string;
}

const DEFAULT_SARVAM_BASE_URL = 'https://api.sarvam.ai';
const DEFAULT_SARVAM_TRANSLATE_MODEL = 'sarvam-translate:v1';
const MAX_TRANSLATE_CHARS = 2000;
const DEFAULT_TARGET_LANGUAGE = 'hi-IN';
const DEFAULT_SOURCE_LANGUAGE = 'en-IN';

const parseArgs = (): Record<string, string> => {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    throw new Error(
      'Usage: pnpm stories:translate <input.jsonl> <output.jsonl> [--target hi-IN] [--source en-IN] [--model sarvam-translate:v1] [--resume true|false]'
    );
  }

  const out: Record<string, string> = {
    input: args[0],
    output: args[1]
  };

  for (let i = 2; i < args.length; i += 1) {
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

const splitTextIntoChunks = (text: string, maxChars: number): string[] => {
  const normalized = text.trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars));
      }
      continue;
    }

    if (!current) {
      current = paragraph;
      continue;
    }

    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      flush();
      current = paragraph;
    }
  }

  flush();
  return chunks;
};

const translateChunk = async (
  input: string,
  config: {
    apiKey: string;
    baseUrl: string;
    sourceLanguage: string;
    targetLanguage: string;
    model: string;
  }
): Promise<string> => {
  const response = await fetch(`${config.baseUrl}/translate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-subscription-key': config.apiKey
    },
    body: JSON.stringify({
      input,
      source_language_code: config.sourceLanguage,
      target_language_code: config.targetLanguage,
      model: config.model,
      mode: 'formal'
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sarvam translate failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as TranslateResponse;
  if (!payload.translated_text) {
    throw new Error('Sarvam translate returned empty translated_text');
  }

  return payload.translated_text;
};

const translateLongText = async (
  text: string,
  config: {
    apiKey: string;
    baseUrl: string;
    sourceLanguage: string;
    targetLanguage: string;
    model: string;
  }
): Promise<string> => {
  const chunks = splitTextIntoChunks(text, MAX_TRANSLATE_CHARS);
  if (chunks.length === 0) return text;

  const translated: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const output = await translateChunk(chunk, config);
    translated.push(output.trim());
    if ((i + 1) % 5 === 0) {
      console.log(`  translated ${i + 1}/${chunks.length} chunks`);
    }
  }

  return translated.join('\n\n');
};

const run = async (): Promise<void> => {
  const args = parseArgs();
  const inputPath = args.input;
  const outputPath = args.output;
  const targetLanguage = args.target ?? DEFAULT_TARGET_LANGUAGE;
  const sourceLanguage = args.source ?? DEFAULT_SOURCE_LANGUAGE;
  const model = args.model ?? DEFAULT_SARVAM_TRANSLATE_MODEL;
  const resume = (args.resume ?? 'true').toLowerCase() !== 'false';
  const baseUrl = (process.env.SARVAM_BASE_URL ?? DEFAULT_SARVAM_BASE_URL).replace(/\/+$/, '');
  const apiKey = process.env.SARVAM_API_KEY;

  if (!apiKey) {
    throw new Error('SARVAM_API_KEY is required');
  }

  await mkdir(dirname(outputPath), { recursive: true });

  const existingStoryIds = new Set<string>();
  let outputExists = false;
  try {
    await access(outputPath);
    outputExists = true;
  } catch {
    outputExists = false;
  }

  if (resume && outputExists) {
    const existingInput = createReadStream(outputPath, 'utf8');
    const existingRl = createInterface({ input: existingInput, crlfDelay: Infinity });
    for await (const line of existingRl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed) as StoryRow;
      if (row.story_id) existingStoryIds.add(row.story_id);
    }
    console.log(`Resume mode: found ${existingStoryIds.size} already translated stories in ${outputPath}`);
  }

  const input = createReadStream(inputPath, 'utf8');
  const rl = createInterface({ input, crlfDelay: Infinity });
  const out = createWriteStream(outputPath, { encoding: 'utf8', flags: resume ? 'a' : 'w' });

  let total = 0;
  let success = 0;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      total += 1;
      const row = JSON.parse(trimmed) as StoryRow;
      if (resume && existingStoryIds.has(row.story_id)) {
        continue;
      }
      const label = `${total}. ${row.story_id}`;
      console.log(`Translating ${label}`);

      const translatedNarrative = await translateLongText(row.narrative_text ?? '', {
        apiKey,
        baseUrl,
        sourceLanguage,
        targetLanguage,
        model
      });

      const translatedMoral = row.moral
        ? await translateLongText(String(row.moral), {
            apiKey,
            baseUrl,
            sourceLanguage,
            targetLanguage,
            model
          })
        : row.moral;

      const outputRow: StoryRow = {
        ...row,
        language: targetLanguage,
        translated_from_language: row.language ?? sourceLanguage,
        narrative_text: translatedNarrative,
        moral: translatedMoral ? String(translatedMoral) : row.moral
      };

      out.write(`${JSON.stringify(outputRow)}\n`);
      success += 1;
    }
  } finally {
    out.end();
  }

  console.log(`Translation complete. ${success}/${total} stories written to ${outputPath}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
