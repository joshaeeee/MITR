export type MemoryType =
  | 'profile'
  | 'preference'
  | 'routine'
  | 'relationship'
  | 'health_context'
  | 'semantic'
  | 'episodic'
  | 'procedural'
  | 'boundary';

export type ContextCardType =
  | 'medication_followup'
  | 'reminder_followup'
  | 'event_followup'
  | 'family_nudge'
  | 'routine_checkin'
  | 'preference_learning'
  | 'care_signal'
  | 'content_offer'
  | 'conversation_repair';

export type ContextCardStatus = 'pending' | 'snoozed' | 'completed' | 'dismissed' | 'expired';

export type MentionPolicy =
  | 'immediate'
  | 'first_safe_user_turn'
  | 'after_current_request'
  | 'when_conversational'
  | 'only_if_user_asks';

export type ContextCardEventType =
  | 'created'
  | 'mentioned'
  | 'answered'
  | 'completed'
  | 'dismissed'
  | 'ignored'
  | 'snoozed'
  | 'expired';

export interface ContextCardCandidate {
  id: string;
  cardType: ContextCardType;
  title: string;
  summary: string;
  priority: number;
  status: ContextCardStatus;
  mentionPolicy: MentionPolicy;
  dueAtMs: number;
  expiresAtMs?: number | null;
  cooldownUntilMs?: number | null;
  lastMentionedAtMs?: number | null;
  mentionCount: number;
  maxMentions: number;
  metadata?: Record<string, unknown>;
}

export interface RankedContextCard extends ContextCardCandidate {
  score: number;
  overdueMinutes: number;
  reason: string;
}

export interface MemoryCandidate {
  id: string;
  memoryType: MemoryType;
  subject: string;
  summary: string;
  importance: number;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface ContextPacketItem {
  cardId?: string;
  type: string;
  priority: number;
  title: string;
  summary: string;
  suggestedLine?: string;
  reason?: string;
}

export interface ContextPacketMemory {
  memoryId: string;
  type: MemoryType;
  subject: string;
  summary: string;
  confidence: number;
}

export interface ContextPacket {
  ok: true;
  version: 'postgres_context_v1';
  elderId: string;
  generatedAt: string;
  freshness?: {
    source: 'live' | 'fresh_cache' | 'stale_cache';
    ageMs: number;
    stale: boolean;
    degradedReason?: string;
  };
  situation: string;
  mustHandle: ContextPacketItem[];
  mayMention: ContextPacketItem[];
  memories: ContextPacketMemory[];
  avoid: string[];
  style: {
    questionBudget: 0 | 1;
    tone: 'quiet' | 'normal' | 'warm' | 'extra_clear';
    proactiveLevel: 'low' | 'medium' | 'high';
  };
  debug?: {
    rankedCardIds: string[];
    suppressedCardIds: string[];
  };
}

export const clampScore = (value: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));

const isDue = (card: ContextCardCandidate, nowMs: number): boolean => card.dueAtMs <= nowMs;
const isExpired = (card: ContextCardCandidate, nowMs: number): boolean =>
  Boolean(card.expiresAtMs && card.expiresAtMs <= nowMs);
const isCoolingDown = (card: ContextCardCandidate, nowMs: number): boolean =>
  Boolean(card.cooldownUntilMs && card.cooldownUntilMs > nowMs);

export const isContextCardEligible = (card: ContextCardCandidate, nowMs: number): boolean => {
  if (card.status !== 'pending' && card.status !== 'snoozed') return false;
  if (isExpired(card, nowMs)) return false;
  if (isCoolingDown(card, nowMs)) return false;
  if (card.mentionCount >= card.maxMentions) return false;
  if (card.mentionPolicy === 'only_if_user_asks') return false;
  return isDue(card, nowMs);
};

export const rankContextCards = (cards: ContextCardCandidate[], nowMs: number): {
  ranked: RankedContextCard[];
  suppressed: ContextCardCandidate[];
} => {
  const ranked: RankedContextCard[] = [];
  const suppressed: ContextCardCandidate[] = [];

  for (const card of cards) {
    if (!isContextCardEligible(card, nowMs)) {
      suppressed.push(card);
      continue;
    }

    const overdueMinutes = Math.max(0, Math.floor((nowMs - card.dueAtMs) / 60000));
    const overdueBoost = Math.min(12, Math.floor(overdueMinutes / 10) * 2);
    const mentionPenalty = card.mentionCount * 12;
    const policyBoost = card.mentionPolicy === 'immediate' || card.mentionPolicy === 'first_safe_user_turn' ? 8 : 0;
    const typeBoost = card.cardType === 'medication_followup' || card.cardType === 'care_signal' ? 10 : 0;
    const score = clampScore(card.priority + overdueBoost + policyBoost + typeBoost - mentionPenalty);

    ranked.push({
      ...card,
      score,
      overdueMinutes,
      reason: `${card.cardType}:${card.mentionPolicy}:score_${score}`
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.priority - a.priority || a.dueAtMs - b.dueAtMs);
  return { ranked, suppressed };
};

const suggestedLineForCard = (card: RankedContextCard): string | undefined => {
  if (card.cardType === 'medication_followup') {
    return `Bas ek chhoti si baat pehle, ${card.title} le li thi?`;
  }
  if (card.cardType === 'reminder_followup') {
    return `${card.title} wala reminder tha. Ho gaya?`;
  }
  if (card.cardType === 'event_followup') {
    return `${card.title} kaisa raha?`;
  }
  if (card.cardType === 'family_nudge') {
    return 'Parivaar se ek message pending hai. Sunaun?';
  }
  return undefined;
};

export const buildContextPacket = (input: {
  elderId: string;
  now: Date;
  triggerType?: string | null;
  cards: ContextCardCandidate[];
  memories: MemoryCandidate[];
  avoidPromptKeys?: string[];
  avoidTopics?: string[];
  proactiveLevel?: 'low' | 'medium' | 'high';
  includeDebug?: boolean;
}): ContextPacket => {
  const nowMs = input.now.getTime();
  const { ranked, suppressed } = rankContextCards(input.cards, nowMs);
  const mustCards = ranked.filter((card) => card.score >= 85).slice(0, 1);
  const mayCards = ranked.filter((card) => !mustCards.some((must) => must.id === card.id)).slice(0, 3);
  const top = mustCards[0] ?? mayCards[0];

  const toPacketItem = (card: RankedContextCard): ContextPacketItem => ({
    cardId: card.id,
    type: card.cardType,
    priority: card.score,
    title: card.title,
    summary: card.summary,
    suggestedLine: suggestedLineForCard(card),
    reason: card.reason
  });

  const avoid = [
    ...(input.avoidTopics ?? []).map((topic) => `Do not bring up "${topic}" unless the user asks.`),
    ...(input.avoidPromptKeys ?? []).slice(0, 8).map((key) => `Avoid repeating proactive prompt key: ${key}.`)
  ];

  const proactiveLevel = input.proactiveLevel ?? 'medium';
  const tone = top?.cardType === 'medication_followup' || top?.cardType === 'care_signal'
    ? 'extra_clear'
    : proactiveLevel === 'low'
      ? 'quiet'
      : 'warm';

  return {
    ok: true,
    version: 'postgres_context_v1',
    elderId: input.elderId,
    generatedAt: input.now.toISOString(),
    situation: top ? `context_card:${top.cardType}` : input.triggerType ?? 'normal_turn',
    mustHandle: mustCards.map(toPacketItem),
    mayMention: mayCards.map(toPacketItem),
    memories: input.memories
      .slice()
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence)
      .slice(0, 6)
      .map((memory) => ({
        memoryId: memory.id,
        type: memory.memoryType,
        subject: memory.subject,
        summary: memory.summary,
        confidence: memory.confidence
      })),
    avoid,
    style: {
      questionBudget: mustCards.length > 0 || mayCards.length > 0 ? 1 : 0,
      tone,
      proactiveLevel
    },
    ...(input.includeDebug
      ? {
          debug: {
            rankedCardIds: ranked.map((card) => card.id),
            suppressedCardIds: suppressed.map((card) => card.id)
          }
        }
      : {})
  };
};
