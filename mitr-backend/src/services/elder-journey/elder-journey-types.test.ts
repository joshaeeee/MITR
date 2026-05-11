import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseConversationPlan,
  resolveEngagementMode,
  resolveRelationshipStage,
  type JourneySignals,
  type PromptHistorySummaryItem
} from './elder-journey-types.js';

const nowMs = Date.UTC(2026, 4, 11, 4, 30);
const dayMs = 24 * 60 * 60 * 1000;

const baseSignals = (overrides: Partial<JourneySignals> = {}): JourneySignals => ({
  nowMs,
  elderCreatedAtMs: nowMs - 30 * dayMs,
  deviceLinkedAtMs: nowMs - 10 * dayMs,
  firstSuccessfulInteractionAtMs: nowMs - 10 * dayMs,
  sessionCount: 6,
  sessionsLast7d: 3,
  totalDurationSec: 900,
  knownRoutineCount: 4,
  knownInterestCount: 3,
  promptCountLast7d: 3,
  acceptedPromptCountLast7d: 2,
  refusedPromptCountLast7d: 0,
  ignoredPromptCountLast7d: 0,
  ...overrides
});

test('relationship stage starts at setup before elder and device context exist', () => {
  assert.equal(
    resolveRelationshipStage(
      baseSignals({
        elderCreatedAtMs: null,
        deviceLinkedAtMs: null,
        firstSuccessfulInteractionAtMs: null,
        sessionCount: 0
      })
    ),
    'setup'
  );
});

test('relationship stage enters ritual trust for first few successful sessions', () => {
  assert.equal(
    resolveRelationshipStage(
      baseSignals({
        firstSuccessfulInteractionAtMs: nowMs - dayMs,
        sessionCount: 2
      })
    ),
    'ritual_trust'
  );
});

test('relationship stage becomes mature after sustained usage and known interests', () => {
  assert.equal(
    resolveRelationshipStage(
      baseSignals({
        firstSuccessfulInteractionAtMs: nowMs - 70 * dayMs,
        sessionCount: 40,
        knownInterestCount: 5
      })
    ),
    'mature'
  );
});

test('engagement mode detects fatigue from repeated ignored/refused prompts', () => {
  assert.equal(
    resolveEngagementMode(
      baseSignals({
        promptCountLast7d: 5,
        acceptedPromptCountLast7d: 1,
        refusedPromptCountLast7d: 2,
        ignoredPromptCountLast7d: 2
      })
    ),
    'fatigued'
  );
});

test('medication fired plan asks only for acknowledgement and retry policy', () => {
  const plan = chooseConversationPlan({
    nowMs,
    triggerType: 'reminder_fired',
    relationshipStage: 'ritual_trust',
    engagementMode: 'cautious',
    localHour: 9,
    promptHistory: [],
    elderName: 'Sharma ji',
    ageRange: '60-69',
    reminderTitle: 'BP tablet',
    knownRoutineCount: 2,
    knownInterestCount: 0,
    onboardingUseCases: [],
    boundaries: {}
  });

  assert.equal(plan.intent, 'medication_confirmation');
  assert.equal(plan.allowedQuestionCount, 1);
  assert.equal(plan.followupPolicy, 'retry_10m');
  assert.match(plan.promptSeed, /BP tablet/);
  assert.ok(plan.constraints.some((constraint) => constraint.includes('Do not assume low digital literacy')));
});

test('post-medication plan closes when engagement is fatigued', () => {
  const plan = chooseConversationPlan({
    nowMs,
    triggerType: 'medication_taken',
    relationshipStage: 'preference_learning',
    engagementMode: 'fatigued',
    localHour: 10,
    promptHistory: [],
    knownRoutineCount: 2,
    knownInterestCount: 1,
    onboardingUseCases: [],
    boundaries: {}
  });

  assert.equal(plan.intent, 'low_pressure_closure');
  assert.equal(plan.allowedQuestionCount, 0);
});

test('post-medication plan prefers a known routine anchor when fresh', () => {
  const plan = chooseConversationPlan({
    nowMs,
    triggerType: 'medication_taken',
    relationshipStage: 'preference_learning',
    engagementMode: 'steady',
    localHour: 10,
    promptHistory: [],
    knownRoutineCount: 2,
    knownInterestCount: 1,
    routineAnchors: [{ label: 'morning yoga' }],
    onboardingUseCases: [],
    boundaries: {}
  });

  assert.equal(plan.intent, 'routine_checkin');
  assert.equal(plan.topic, 'morning yoga');
  assert.match(plan.promptSeed, /morning yoga/);
});

test('preference learning turns onboarding use cases into concrete choices', () => {
  const plan = chooseConversationPlan({
    nowMs,
    triggerType: 'manual',
    relationshipStage: 'preference_learning',
    engagementMode: 'steady',
    localHour: 14,
    promptHistory: [],
    knownRoutineCount: 2,
    knownInterestCount: 1,
    onboardingUseCases: ['medicine reminders'],
    boundaries: {}
  });

  assert.equal(plan.intent, 'preference_learning');
  assert.equal(plan.topic, 'medicine reminders');
  assert.match(plan.promptSeed, /roz yaad dilana/);
});

test('mature session uses life story prompt only when cooldown allows it', () => {
  const recentHistory: PromptHistorySummaryItem[] = [
    'life_story:first_work',
    'life_story:old_home',
    'life_story:favourite_music',
    'life_story:festival_memory'
  ].map((promptKey) => ({
    promptKey,
    promptType: 'life_story',
    responseState: 'completed',
    createdAtMs: nowMs - 2 * dayMs
  }));

  const plan = chooseConversationPlan({
    nowMs,
    triggerType: 'manual',
    relationshipStage: 'mature',
    engagementMode: 'conversational',
    localHour: 14,
    promptHistory: recentHistory,
    knownRoutineCount: 5,
    knownInterestCount: 4,
    onboardingUseCases: [],
    boundaries: {}
  });

  assert.notEqual(plan.intent, 'life_story_prompt');
});
