export type RelationshipStage =
  | 'setup'
  | 'first_use'
  | 'ritual_trust'
  | 'preference_learning'
  | 'relationship_building'
  | 'mature';

export type EngagementMode = 'cautious' | 'steady' | 'conversational' | 'low_response' | 'fatigued';

export type ConversationTriggerType =
  | 'session_start'
  | 'first_use'
  | 'reminder_fired'
  | 'reminder_acknowledged'
  | 'medication_taken'
  | 'medication_delayed'
  | 'routine_time'
  | 'morning'
  | 'evening'
  | 'caregiver_nudge'
  | 'user_quiet'
  | 'user_requested'
  | 'manual';

export type ConversationIntent =
  | 'onboarding_practice'
  | 'medication_confirmation'
  | 'medication_recovery'
  | 'routine_checkin'
  | 'daily_briefing_offer'
  | 'devotional_offer'
  | 'family_bridge'
  | 'life_story_prompt'
  | 'light_game'
  | 'preference_learning'
  | 'low_pressure_closure'
  | 'direct_answer';

export type PromptResponseState = 'planned' | 'accepted' | 'refused' | 'ignored' | 'unclear' | 'completed';
export type PromptSentiment = 'positive' | 'neutral' | 'negative';

export interface JourneySignals {
  nowMs: number;
  elderCreatedAtMs?: number | null;
  deviceLinkedAtMs?: number | null;
  firstSuccessfulInteractionAtMs?: number | null;
  sessionCount: number;
  sessionsLast7d: number;
  totalDurationSec: number;
  knownRoutineCount: number;
  knownInterestCount: number;
  promptCountLast7d: number;
  acceptedPromptCountLast7d: number;
  refusedPromptCountLast7d: number;
  ignoredPromptCountLast7d: number;
  ageRange?: string | null;
  stageOverride?: RelationshipStage | null;
}

export interface PromptHistorySummaryItem {
  promptKey: string;
  promptType: string;
  responseState: PromptResponseState;
  createdAtMs: number;
}

export interface ConversationPlanInput {
  triggerType: ConversationTriggerType;
  relationshipStage: RelationshipStage;
  engagementMode: EngagementMode;
  localHour: number;
  promptHistory: PromptHistorySummaryItem[];
  elderName?: string;
  ageRange?: string | null;
  preferredAddress?: string | null;
  reminderTitle?: string | null;
  routineTitle?: string | null;
  routineKey?: string | null;
  knownRoutineCount: number;
  knownInterestCount: number;
  routineAnchors?: Array<Record<string, unknown>>;
  interests?: Array<Record<string, unknown>>;
  onboardingUseCases: string[];
  boundaries: Record<string, unknown>;
}

export interface ConversationPlan {
  intent: ConversationIntent;
  promptType: string;
  promptKey: string;
  topic?: string;
  promptSeed: string;
  spokenGuidance: string;
  allowedQuestionCount: 0 | 1;
  tone: 'normal' | 'extra_clear' | 'quiet' | 'warm' | 'concerned';
  followupPolicy: 'none' | 'retry_10m' | 'retry_20m' | 'family_policy';
  recordPrompt: boolean;
  avoidPromptKeys: string[];
  constraints: string[];
  toolHints: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const clampNonNegative = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

export const daysSince = (nowMs: number, thenMs?: number | null): number | null => {
  if (!thenMs || !Number.isFinite(thenMs)) return null;
  return Math.floor(clampNonNegative(nowMs - thenMs) / DAY_MS);
};

export const resolveRelationshipStage = (signals: JourneySignals): RelationshipStage => {
  if (signals.stageOverride) return signals.stageOverride;

  if (!signals.elderCreatedAtMs) return 'setup';
  if (!signals.deviceLinkedAtMs && signals.sessionCount === 0) return 'setup';

  const startMs = signals.firstSuccessfulInteractionAtMs ?? signals.deviceLinkedAtMs ?? signals.elderCreatedAtMs;
  const relationshipAgeDays = daysSince(signals.nowMs, startMs) ?? 0;

  if (!signals.firstSuccessfulInteractionAtMs && signals.sessionCount === 0) return 'first_use';
  if (relationshipAgeDays <= 3 || signals.sessionCount < 3) return 'ritual_trust';
  if (relationshipAgeDays <= 14 || signals.knownInterestCount < 2) return 'preference_learning';
  if (relationshipAgeDays <= 42) return 'relationship_building';
  return 'mature';
};

export const resolveEngagementMode = (signals: JourneySignals): EngagementMode => {
  const deviceAgeDays = daysSince(signals.nowMs, signals.deviceLinkedAtMs ?? signals.elderCreatedAtMs) ?? 0;
  if (deviceAgeDays >= 7 && signals.sessionsLast7d === 0) return 'low_response';

  const negativeSignals = signals.refusedPromptCountLast7d + signals.ignoredPromptCountLast7d;
  if (signals.promptCountLast7d >= 3 && negativeSignals >= 3 && negativeSignals >= signals.acceptedPromptCountLast7d) {
    return 'fatigued';
  }

  const avgSessionDurationSec = signals.sessionCount > 0 ? signals.totalDurationSec / signals.sessionCount : 0;
  if (signals.sessionsLast7d >= 3 && avgSessionDurationSec >= 180 && signals.acceptedPromptCountLast7d >= 2) {
    return 'conversational';
  }

  return signals.sessionCount < 3 ? 'cautious' : 'steady';
};

export const isPromptOnCooldown = (
  history: PromptHistorySummaryItem[],
  promptKey: string,
  nowMs: number,
  cooldownDays: number
): boolean => {
  if (cooldownDays <= 0) return false;
  const cooldownMs = cooldownDays * DAY_MS;
  return history.some((item) => item.promptKey === promptKey && nowMs - item.createdAtMs < cooldownMs);
};

export const inferLocalHour = (now: Date, timeZone = 'Asia/Kolkata'): number => {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false
  }).format(now);
  const parsed = Number(hour);
  return Number.isFinite(parsed) ? parsed : now.getHours();
};

export const isSixtiesRange = (ageRange?: string | null): boolean => {
  if (!ageRange) return false;
  return /\b6\d\b|60|65|sixt/i.test(ageRange);
};

const recentPromptKeys = (history: PromptHistorySummaryItem[], limit = 12): string[] =>
  history
    .slice()
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit)
    .map((item) => item.promptKey);

const chooseFreshKey = (
  history: PromptHistorySummaryItem[],
  nowMs: number,
  candidates: Array<{ key: string; cooldownDays: number }>
): string => candidates.find((candidate) => !isPromptOnCooldown(history, candidate.key, nowMs, candidate.cooldownDays))?.key ?? candidates[0]!.key;

const chooseFreshCandidate = <T extends { key: string; cooldownDays: number }>(
  history: PromptHistorySummaryItem[],
  nowMs: number,
  candidates: T[]
): T | null => candidates.find((candidate) => !isPromptOnCooldown(history, candidate.key, nowMs, candidate.cooldownDays)) ?? null;

const address = (input: ConversationPlanInput): string =>
  input.preferredAddress?.trim() || input.elderName?.trim() || 'aap';

const slugKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'item';

const extractLabels = (items: Array<Record<string, unknown>> | undefined): string[] =>
  (items ?? [])
    .map((item) => {
      const value = item.label ?? item.title ?? item.name ?? item.topic;
      return typeof value === 'string' ? value.trim() : '';
    })
    .filter(Boolean)
    .slice(0, 8);

const chooseFreshLabel = (
  history: PromptHistorySummaryItem[],
  nowMs: number,
  labels: string[],
  prefix: string,
  cooldownDays: number
): { label: string; key: string } | null => {
  for (const label of labels) {
    const key = `${prefix}:${slugKey(label)}`;
    if (!isPromptOnCooldown(history, key, nowMs, cooldownDays)) {
      return { label, key };
    }
  }
  return null;
};

const baseConstraints = (input: ConversationPlanInput): string[] => {
  const constraints = [
    'Speak adult-to-adult; never use baby-talk, exaggerated praise, or patronizing collective "we".',
    'Use one short spoken turn and at most one question.',
    'Treat refusal or silence as a preference signal, not a failure.',
    'Do not list features; make the next useful action obvious.'
  ];
  if (input.relationshipStage === 'ritual_trust' || input.relationshipStage === 'first_use') {
    constraints.push('Keep the interaction anchored to a routine, reminder, family message, news, music, or prayer.');
  }
  if (isSixtiesRange(input.ageRange)) {
    constraints.push('Do not assume low digital literacy; many users in their 60s use phones and social apps comfortably.');
  }
  if (input.engagementMode === 'fatigued') {
    constraints.push('Reduce proactivity and close warmly unless the user asks for more.');
  }
  return constraints;
};

export const chooseConversationPlan = (input: ConversationPlanInput & { nowMs: number }): ConversationPlan => {
  const avoidPromptKeys = recentPromptKeys(input.promptHistory);
  const constraints = baseConstraints(input);
  const name = address(input);
  const earlyStage = input.relationshipStage === 'first_use' || input.relationshipStage === 'ritual_trust';

  if (input.triggerType === 'reminder_fired') {
    const title = input.reminderTitle?.trim() || 'is reminder';
    return {
      intent: 'medication_confirmation',
      promptType: 'medication',
      promptKey: `medication_confirmation:${title.toLowerCase()}`,
      topic: title,
      promptSeed: `${title} ka samay ho gaya hai. Ho jaye toh bas bol dijiye, "le li", ya "baad mein yaad dilao".`,
      spokenGuidance: 'Ask for a simple acknowledgement. Do not add a second topic until the medicine response is clear.',
      allowedQuestionCount: 1,
      tone: 'extra_clear',
      followupPolicy: 'retry_10m',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use medication_response_record after the elder says taken, later, no, or unclear.']
    };
  }

  if (input.triggerType === 'medication_delayed') {
    const title = input.reminderTitle?.trim() || 'dawa';
    return {
      intent: 'medication_recovery',
      promptType: 'medication',
      promptKey: `medication_recovery:${title.toLowerCase()}`,
      topic: title,
      promptSeed: `Theek hai, main thodi der baad phir yaad dilaunga. ${title} rehni nahi chahiye.`,
      spokenGuidance: 'Acknowledge the delay without guilt or pressure.',
      allowedQuestionCount: 0,
      tone: 'normal',
      followupPolicy: 'retry_10m',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use medication_response_record with status delayed.']
    };
  }

  if (input.triggerType === 'reminder_acknowledged' || input.triggerType === 'medication_taken') {
    const key = chooseFreshKey(input.promptHistory, input.nowMs, [
      { key: 'post_med:routine_checkin', cooldownDays: 1 },
      { key: 'post_med:news_or_bhajan', cooldownDays: 1 },
      { key: 'post_med:close', cooldownDays: 0 }
    ]);

    if (input.engagementMode === 'fatigued' || key === 'post_med:close') {
      return {
        intent: 'low_pressure_closure',
        promptType: 'closure',
        promptKey: 'post_med:close',
        promptSeed: 'Theek hai, note kar li. Main agle reminder ke time phir bata dunga.',
        spokenGuidance: 'Close warmly and do not ask a new question.',
        allowedQuestionCount: 0,
        tone: 'quiet',
        followupPolicy: 'none',
        recordPrompt: true,
        avoidPromptKeys,
        constraints,
        toolHints: []
      };
    }

    const routineAnchor = chooseFreshLabel(
      input.promptHistory,
      input.nowMs,
      extractLabels(input.routineAnchors),
      'post_med:routine',
      1
    );
    return key === 'post_med:news_or_bhajan'
      ? {
          intent: 'daily_briefing_offer',
          promptType: 'choice',
          promptKey: key,
          promptSeed: 'Theek hai, note kar li. Ab thoda sunna chahenge: aaj ki khabar, bhajan, ya bas shanti?',
          spokenGuidance: 'Offer a small choice. If they choose news, call news_retrieve first.',
          allowedQuestionCount: 1,
          tone: 'warm',
          followupPolicy: 'none',
          recordPrompt: true,
          avoidPromptKeys,
          constraints,
          toolHints: ['If the user chooses news, use news_retrieve before answering.', 'If the user chooses bhajan, use devotional_playlist_get or youtube_media_get.']
        }
      : {
          intent: 'routine_checkin',
          promptType: 'routine',
          promptKey: routineAnchor?.key ?? key,
          topic: routineAnchor?.label,
          promptSeed: routineAnchor
            ? `Theek hai, note kar li. Aaj ${routineAnchor.label} ka routine ho gaya?`
            : 'Theek hai, note kar li. Aaj nashta ya chai ho gayi?',
          spokenGuidance: 'Ask one routine-linked question only, preferably using a known daily anchor.',
          allowedQuestionCount: 1,
          tone: 'normal',
          followupPolicy: 'none',
          recordPrompt: true,
          avoidPromptKeys,
          constraints,
          toolHints: []
        };
  }

  if (input.triggerType === 'user_quiet' || input.engagementMode === 'low_response' || input.engagementMode === 'fatigued') {
    return {
      intent: 'low_pressure_closure',
      promptType: 'closure',
      promptKey: 'low_pressure_closure',
      promptSeed: 'Theek hai. Main yahin hoon. Zarurat ho toh bas Reca bol dijiye.',
      spokenGuidance: 'Do not push. Close the turn and leave control with the elder.',
      allowedQuestionCount: 0,
      tone: 'quiet',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: []
    };
  }

  if (input.relationshipStage === 'setup' || input.triggerType === 'first_use') {
    return {
      intent: 'onboarding_practice',
      promptType: 'onboarding',
      promptKey: 'onboarding:first_practice',
      promptSeed: `Namaste ${name}. Main Reca hoon. Main dawa, routine, family message, khabar, bhajan aur kahani mein madad kar sakta hoon. Abhi ek chhota sa test karein?`,
      spokenGuidance: 'Introduce only the most useful capabilities and invite one practice interaction.',
      allowedQuestionCount: 1,
      tone: 'extra_clear',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: []
    };
  }

  if (input.triggerType === 'caregiver_nudge') {
    return {
      intent: 'family_bridge',
      promptType: 'family',
      promptKey: 'family:nudge_bridge',
      promptSeed: 'Aapke parivaar se ek message aaya hai. Main sunaun?',
      spokenGuidance: 'Ask permission before playing or summarizing a family nudge.',
      allowedQuestionCount: 1,
      tone: 'warm',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use nudge_pending_get before speaking family messages.']
    };
  }

  if (input.triggerType === 'routine_time' && input.routineTitle) {
    return {
      intent: 'routine_checkin',
      promptType: 'routine',
      promptKey: `routine:${input.routineKey || input.routineTitle.toLowerCase()}`,
      topic: input.routineTitle,
      promptSeed: `${input.routineTitle} ka samay ho raha hai. Aap karna chahenge, ya baad mein yaad dilau?`,
      spokenGuidance: 'Use the configured routine anchor and keep it practical.',
      allowedQuestionCount: 1,
      tone: 'normal',
      followupPolicy: 'retry_20m',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: []
    };
  }

  const morning = input.localHour >= 5 && input.localHour < 11;
  const evening = input.localHour >= 17 && input.localHour < 21;

  if (morning || input.triggerType === 'morning') {
    return {
      intent: 'daily_briefing_offer',
      promptType: 'briefing',
      promptKey: 'morning:daily_briefing',
      promptSeed: earlyStage
        ? 'Subah ke liye main bas chhoti jaankari de sakta hoon: aaj ka din, reminders, aur ek vichar. Sunna chahenge?'
        : 'Subah ki chhoti briefing sunaun: aaj ke reminders, ek vichar, aur zarurat ho toh khabar?',
      spokenGuidance: 'Offer the morning briefing. Call daily_briefing_get if the user accepts.',
      allowedQuestionCount: 1,
      tone: 'normal',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use daily_briefing_get after the user accepts.', 'Use news_retrieve before factual news.']
    };
  }

  if (evening || input.triggerType === 'evening') {
    return {
      intent: 'devotional_offer',
      promptType: 'devotional',
      promptKey: 'evening:devotional_or_music',
      promptSeed: earlyStage
        ? 'Shaam ko halka sa bhajan ya shanti wala sangeet sunna chahenge?'
        : 'Shaam ke liye bhajan, kahani, ya thodi der ki shaant baat - kya pasand rahega?',
      spokenGuidance: 'Offer a calm evening path. Do not assume religion; adapt if the elder prefers music/news instead.',
      allowedQuestionCount: 1,
      tone: 'warm',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use devotional_playlist_get, story_retrieve, or flow_start only after user choice.']
    };
  }

  if (input.relationshipStage === 'relationship_building' || input.relationshipStage === 'mature') {
    const lifeStory = chooseFreshCandidate(input.promptHistory, input.nowMs, [
      {
        key: 'life_story:first_work',
        cooldownDays: 10,
        promptSeed: 'Aaj ek chhoti si yaad record karein? Jaise pehli naukri ya kaam ka pehla din.',
        topic: 'first work'
      },
      {
        key: 'life_story:old_home',
        cooldownDays: 10,
        promptSeed: 'Aaj ek chhoti si yaad record karein? Pehle ghar ya purane mohalla ki koi baat yaad aati hai?',
        topic: 'old home'
      },
      {
        key: 'life_story:favourite_music',
        cooldownDays: 10,
        promptSeed: 'Aaj ek chhoti si yaad record karein? Koi gaana ya kalakar jo pehle bahut pasand tha?',
        topic: 'music memory'
      },
      {
        key: 'life_story:festival_memory',
        cooldownDays: 10,
        promptSeed: 'Aaj ek chhoti si yaad record karein? Bachpan ya jawani ka koi tyohar jo yaad reh gaya ho?',
        topic: 'festival memory'
      }
    ]);
    if (lifeStory) {
      return {
        intent: 'life_story_prompt',
        promptType: 'life_story',
        promptKey: lifeStory.key,
        topic: lifeStory.topic,
        promptSeed: lifeStory.promptSeed,
        spokenGuidance: 'Ask a specific optional memory prompt. If the elder answers in detail, use diary_add.',
        allowedQuestionCount: 1,
        tone: 'warm',
        followupPolicy: 'none',
        recordPrompt: true,
        avoidPromptKeys,
        constraints,
        toolHints: ['Use diary_add if the user shares a life-story memory and wants it saved.']
      };
    }
  }

  const useCase = chooseFreshLabel(input.promptHistory, input.nowMs, input.onboardingUseCases, 'preference:usecase', 3);
  if (input.relationshipStage === 'preference_learning' && useCase) {
    return {
      intent: 'preference_learning',
      promptType: 'preference',
      promptKey: useCase.key,
      topic: useCase.label,
      promptSeed: `Aapne Reca ke liye "${useCase.label}" bataya tha. Isko roz yaad dilana theek rahega, ya sirf jab aap bolein?`,
      spokenGuidance: 'Convert an onboarding use case into a concrete preference. Keep it as a choice, not an interview.',
      allowedQuestionCount: 1,
      tone: 'normal',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: []
    };
  }

  const interest = chooseFreshLabel(input.promptHistory, input.nowMs, extractLabels(input.interests), 'interest:checkin', 5);
  if ((input.relationshipStage === 'relationship_building' || input.relationshipStage === 'mature') && interest) {
    return {
      intent: 'preference_learning',
      promptType: 'interest',
      promptKey: interest.key,
      topic: interest.label,
      promptSeed: `${interest.label} ke baare mein aaj kuch sunna ya baat karna pasand karenge?`,
      spokenGuidance: 'Use a known interest and ask permission before expanding it.',
      allowedQuestionCount: 1,
      tone: 'warm',
      followupPolicy: 'none',
      recordPrompt: true,
      avoidPromptKeys,
      constraints,
      toolHints: ['Use news_retrieve for current factual updates, or story_retrieve/youtube_media_get when the elder chooses content.']
    };
  }

  return {
    intent: input.relationshipStage === 'preference_learning' ? 'preference_learning' : 'light_game',
    promptType: input.relationshipStage === 'preference_learning' ? 'preference' : 'game',
    promptKey: input.relationshipStage === 'preference_learning' ? 'preference:content_time' : 'game:light_riddle',
    promptSeed:
      input.relationshipStage === 'preference_learning'
        ? 'Aapko Reca se zyada kis time baat karna achha lagta hai: subah, dopahar, ya shaam?'
        : 'Ek chhoti si paheli ya halka sa game khelenge?',
    spokenGuidance: 'Keep this optional and easy to refuse.',
    allowedQuestionCount: 1,
    tone: 'normal',
    followupPolicy: 'none',
    recordPrompt: true,
    avoidPromptKeys,
    constraints,
    toolHints: input.relationshipStage === 'preference_learning' ? [] : ['Use brain_game_get if the user accepts.']
  };
};
