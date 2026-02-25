import { randomUUID } from 'node:crypto';
import { Citation, ReligiousRetriever } from '../retrieval/religious-retriever.js';
import { logger } from '../../lib/logger.js';

export type SatsangAction = 'continue' | 'reflect' | 'question' | 'summarize' | 'close' | 'new_text';

export interface SatsangStartInput {
  userId: string;
  topic?: string;
  tradition?: string;
  language?: string;
  interactive?: boolean;
}

export interface SatsangNextInput {
  userId: string;
  action?: SatsangAction;
  query?: string;
}

interface SatsangSession {
  sessionId: string;
  userId: string;
  topic: string;
  tradition?: string;
  language: string;
  interactive: boolean;
  phase: 'invocation' | 'shastra_path' | 'vyakhya' | 'manan' | 'sankalp';
  citationIndex: number;
  citations: Citation[];
  startedAt: number;
  updatedAt: number;
}

const DEFAULT_TOPIC = 'Bhagavad Gita: shanti aur dhairya';
const RETRIEVAL_TIMEOUT_MS = 2200;

const toSnippet = (text: string, maxChars = 700): string => {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}...`;
};

export class SatsangService {
  private sessions = new Map<string, SatsangSession>();

  constructor(private readonly retriever: ReligiousRetriever) {}

  async start(input: SatsangStartInput): Promise<Record<string, unknown>> {
    const topic = (input.topic?.trim() || DEFAULT_TOPIC).slice(0, 200);
    const language = input.language ?? 'hi-IN';
    const interactive = input.interactive ?? true;
    const citations = await this.fetchCitationsSafe(topic, language, input.tradition);

    const session: SatsangSession = {
      sessionId: randomUUID(),
      userId: input.userId,
      topic,
      tradition: input.tradition,
      language,
      interactive,
      phase: 'invocation',
      citationIndex: 0,
      citations,
      startedAt: Date.now(),
      updatedAt: Date.now()
    };
    this.sessions.set(input.userId, session);

    const first = citations[0];
    const opening = `Aaiye satsang shuru karte hain. Aaj ka vishay: ${topic}. Pehle ek chhota mangalacharan karte hain, phir shastra paath aur vichar karenge.`;

    return {
      ok: true,
      mode: 'satsang',
      sessionId: session.sessionId,
      stage: 'invocation',
      topic: session.topic,
      tradition: session.tradition,
      interactive: session.interactive,
      opening,
      source: first ? { title: first.title, source: first.source } : undefined,
      nextActions: ['continue', 'question', 'close'],
      prompt: 'Boliye: "agla paath" ya "sawaal puchho" ya "satsang samaapt".'
    };
  }

  async next(input: SatsangNextInput): Promise<Record<string, unknown>> {
    const session = this.sessions.get(input.userId);
    if (!session) {
      return {
        ok: false,
        error: 'No active satsang session. Start with flow_start.'
      };
    }

    const action = input.action ?? 'continue';
    if (action === 'close') {
      this.sessions.delete(input.userId);
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'closing',
        content: 'Aaj ka satsang yahin samaapt karte hain. Hari Om.',
        summaryHint: `Aaj humne "${session.topic}" par chintan kiya.`
      };
    }

    if (input.query?.trim()) {
      session.citations = await this.fetchCitationsSafe(
        input.query.trim(),
        session.language,
        session.tradition
      );
      session.citationIndex = 0;
      session.phase = 'invocation';
      session.topic = input.query.trim().slice(0, 200);
    }

    const current = this.getCurrentCitation(session);
    session.updatedAt = Date.now();

    if (!current) {
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'invocation',
        content:
          'Filhaal is vishay par pratyaksh paath uplabdh nahi mila. Chaliye satya, daya aur dhairya par sankshipt satsang karte hain.',
        nextActions: ['continue', 'close']
      };
    }

    if (action === 'summarize') {
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'summary',
        content: `Saar: ${toSnippet(current.passage, 320)} Aaj ka kendriya vichar: dhairya, maryada aur satya.`,
        source: { title: current.title, source: current.source },
        nextActions: ['continue', 'close']
      };
    }

    if (action === 'question') {
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'manan',
        content: 'Is paath se aap apne jeevan mein kaunsi ek baat lagu karna chahenge?',
        source: { title: current.title, source: current.source },
        nextActions: ['reflect', 'continue', 'close']
      };
    }

    if (action === 'reflect') {
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'vyakhya',
        content: `Vichar: ${toSnippet(current.passage, 500)} Iska jeevan prayog hai ki kathin paristhiti mein bhi dhairya aur maryada banaye rakhein.`,
        source: { title: current.title, source: current.source },
        nextActions: ['question', 'continue', 'close']
      };
    }

    return this.nextStructuredPhase(session, current);
  }

  end(userId: string): Record<string, unknown> {
    const existing = this.sessions.get(userId);
    if (!existing) return { ok: false, error: 'No active satsang session.' };
    this.sessions.delete(userId);
    return {
      ok: true,
      mode: 'satsang',
      sessionId: existing.sessionId,
      stage: 'closed'
    };
  }

  private async fetchCitations(topic: string, language?: string, tradition?: string): Promise<Citation[]> {
    const hits = await this.retriever.retrieve({
      query: `${topic} satsang explanation`,
      language,
      tradition,
      depth: 'deep'
    });
    return hits.slice(0, 6);
  }

  private async fetchCitationsSafe(
    topic: string,
    language?: string,
    tradition?: string
  ): Promise<Citation[]> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        this.fetchCitations(topic, language, tradition),
        new Promise<Citation[]>((resolve) => {
          timer = setTimeout(() => resolve([]), RETRIEVAL_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      logger.warn('Satsang citation retrieval failed, continuing with fallback flow', {
        reason: (error as Error).message
      });
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getCurrentCitation(session: SatsangSession): Citation | null {
    if (session.citations.length === 0) return null;
    const idx = Math.min(session.citationIndex, session.citations.length - 1);
    return session.citations[idx] ?? null;
  }

  private nextStructuredPhase(session: SatsangSession, current: Citation): Record<string, unknown> {
    if (session.phase === 'invocation') {
      session.phase = 'shastra_path';
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'invocation',
        content: 'Mangalacharan: Om shanti shanti shanti. Ab hum shastra paath ki aur badhte hain.',
        nextActions: ['continue', 'question', 'close']
      };
    }

    if (session.phase === 'shastra_path') {
      session.phase = 'vyakhya';
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'shastra_path',
        content: `Paath: ${toSnippet(current.passage)} (Srot: ${current.title})`,
        source: { title: current.title, source: current.source },
        nextActions: ['continue', 'reflect', 'question', 'close']
      };
    }

    if (session.phase === 'vyakhya') {
      session.phase = 'manan';
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'vyakhya',
        content: `Saral vyakhya: ${toSnippet(current.passage, 420)} Yeh paath humein dhairya, vivek aur dayabhav ki yaad dilata hai.`,
        source: { title: current.title, source: current.source },
        nextActions: ['continue', 'question', 'close']
      };
    }

    if (session.phase === 'manan') {
      session.phase = 'sankalp';
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'manan',
        content: 'Manan prashn: aaj ke paath ki kaunsi baat aap aaj hi jeevan mein apna sakte hain?',
        source: { title: current.title, source: current.source },
        nextActions: ['continue', 'reflect', 'close']
      };
    }

    // sankalp -> move to next citation, or close
    const hasMore = session.citationIndex < session.citations.length - 1;
    if (hasMore) {
      session.citationIndex += 1;
      session.phase = 'shastra_path';
      return {
        ok: true,
        mode: 'satsang',
        sessionId: session.sessionId,
        stage: 'sankalp',
        content: 'Aaj ka sankalp: bolne aur sochne mein shaanti aur maryada rakhenge. Ab agla paath shuru karte hain.',
        nextActions: ['continue', 'question', 'close']
      };
    }

    this.sessions.delete(session.userId);
    return {
      ok: true,
      mode: 'satsang',
      sessionId: session.sessionId,
      stage: 'closing',
      content: `Aaj ka satsang "${session.topic}" par sampann hua. Hari Om Tat Sat.`,
      summaryHint: 'Aap chahein to kal is vishay ka agla satsang phir shuru kar sakte hain.',
      nextActions: ['close']
    };
  }
}
