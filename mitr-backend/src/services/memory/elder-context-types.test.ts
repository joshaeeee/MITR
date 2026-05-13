import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPacket, rankContextCards, type ContextCardCandidate } from './elder-context-types.js';

const now = new Date('2026-05-12T09:30:00.000Z');
const baseCard = (overrides: Partial<ContextCardCandidate>): ContextCardCandidate => ({
  id: overrides.id ?? 'card-1',
  cardType: overrides.cardType ?? 'event_followup',
  title: overrides.title ?? 'Doctor visit',
  summary: overrides.summary ?? 'Ask how the doctor visit went.',
  priority: overrides.priority ?? 50,
  status: overrides.status ?? 'pending',
  mentionPolicy: overrides.mentionPolicy ?? 'when_conversational',
  dueAtMs: overrides.dueAtMs ?? now.getTime() - 60_000,
  expiresAtMs: overrides.expiresAtMs,
  cooldownUntilMs: overrides.cooldownUntilMs,
  lastMentionedAtMs: overrides.lastMentionedAtMs,
  mentionCount: overrides.mentionCount ?? 0,
  maxMentions: overrides.maxMentions ?? 1,
  metadata: overrides.metadata
});

test('rankContextCards promotes overdue medication follow-up above casual event follow-up', () => {
  const { ranked } = rankContextCards(
    [
      baseCard({ id: 'event', cardType: 'event_followup', priority: 60 }),
      baseCard({
        id: 'med',
        cardType: 'medication_followup',
        title: 'BP medicine',
        priority: 88,
        mentionPolicy: 'first_safe_user_turn',
        dueAtMs: now.getTime() - 30 * 60_000
      })
    ],
    now.getTime()
  );

  assert.equal(ranked[0]?.id, 'med');
  assert.ok((ranked[0]?.score ?? 0) >= 85);
});

test('rankContextCards suppresses expired, cooling, and over-mentioned cards', () => {
  const { ranked, suppressed } = rankContextCards(
    [
      baseCard({ id: 'expired', expiresAtMs: now.getTime() - 1 }),
      baseCard({ id: 'cooling', cooldownUntilMs: now.getTime() + 10_000 }),
      baseCard({ id: 'done-mentions', mentionCount: 1, maxMentions: 1 }),
      baseCard({ id: 'eligible', mentionCount: 0, maxMentions: 2 })
    ],
    now.getTime()
  );

  assert.deepEqual(ranked.map((card) => card.id), ['eligible']);
  assert.deepEqual(
    suppressed.map((card) => card.id).sort(),
    ['cooling', 'done-mentions', 'expired']
  );
});

test('buildContextPacket separates must-handle cards from lower priority may-mention cards', () => {
  const packet = buildContextPacket({
    elderId: 'elder-1',
    now,
    triggerType: 'session_start',
    cards: [
      baseCard({
        id: 'med',
        cardType: 'medication_followup',
        title: 'BP medicine',
        priority: 90,
        mentionPolicy: 'first_safe_user_turn'
      }),
      baseCard({
        id: 'family',
        cardType: 'family_nudge',
        title: 'Family message',
        priority: 90,
        mentionPolicy: 'first_safe_user_turn'
      }),
      baseCard({ id: 'doctor', cardType: 'event_followup', priority: 55 })
    ],
    memories: [
      {
        id: 'memory-1',
        memoryType: 'preference',
        subject: 'news',
        summary: 'Prefers short Hindi news.',
        importance: 70,
        confidence: 80
      }
    ],
    avoidPromptKeys: ['routine:yoga'],
    avoidTopics: ['politics'],
    proactiveLevel: 'medium'
  });

  assert.equal(packet.mustHandle[0]?.cardId, 'med');
  assert.equal(packet.mustHandle.length, 1);
  assert.equal(packet.mayMention[0]?.cardId, 'family');
  assert.equal(packet.memories[0]?.summary, 'Prefers short Hindi news.');
  assert.ok(packet.avoid.some((item) => item.includes('routine:yoga')));
  assert.equal(packet.style.questionBudget, 1);
});
