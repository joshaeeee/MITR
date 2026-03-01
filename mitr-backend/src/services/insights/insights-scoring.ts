export type ScoreBand = 'stable' | 'watch' | 'concern';

export type ExtractedSignalFeatures = {
  wordCount: number;
  questionCount: number;
  pauseMarkerCount: number;
  exclamationCount: number;
  positiveHits: number;
  negativeHits: number;
  distressHits: number;
  confusionHits: number;
  socialHits: number;
  familyHits: number;
  adherenceHits: number;
  topics: string[];
  topicCounts: Record<string, number>;
};

const POSITIVE_TERMS = [
  'happy',
  'good',
  'better',
  'calm',
  'grateful',
  'thankful',
  'peaceful',
  'cheerful',
  'खुश',
  'अच्छा',
  'ठीक',
  'सुकून',
  'शांत',
  'behtar',
  'khush'
];

const NEGATIVE_TERMS = [
  'sad',
  'bad',
  'worried',
  'anxious',
  'tired',
  'upset',
  'lonely',
  'depressed',
  'उदास',
  'परेशान',
  'थका',
  'अकेला',
  'bechain',
  'udaas',
  'tanha'
];

const DISTRESS_TERMS = [
  'panic',
  'helpless',
  'hopeless',
  'scared',
  'fear',
  'pain',
  'hurt',
  'मरना',
  'डर',
  'दर्द',
  'घबराहट',
  'takleef',
  'khatra',
  'dar'
];

const CONFUSION_TERMS = [
  'forget',
  'forgot',
  'confused',
  'unclear',
  'what day',
  'कौन सा दिन',
  'याद नहीं',
  'भूल',
  'samajh nahi',
  'yaad nahi'
];

const SOCIAL_TERMS = [
  'friend',
  'neighbour',
  'community',
  'temple',
  'visit',
  'milna',
  'मिलना',
  'संगत',
  'सत्संग',
  'समाज'
];

const FAMILY_TERMS = [
  'family',
  'son',
  'daughter',
  'grandson',
  'granddaughter',
  'wife',
  'husband',
  'माँ',
  'पिता',
  'बेटा',
  'बेटी',
  'परिवार',
  'ghar',
  'bachche'
];

const ADHERENCE_TERMS = [
  'medicine',
  'medication',
  'tablet',
  'dose',
  'routine',
  'reminder',
  'walk',
  'exercise',
  'दवाई',
  'गोली',
  'समय',
  'रूटीन',
  'yoga',
  'pranayam'
];

const TOPIC_KEYWORDS: Record<string, string[]> = {
  spiritual_reflection: ['gita', 'bhajan', 'satsang', 'shloka', 'राम', 'कृष्ण', 'प्रार्थना', 'भजन'],
  family_connection: ['family', 'son', 'daughter', 'बेटा', 'बेटी', 'परिवार', 'ghar', 'bachche'],
  health_routine: ['medicine', 'tablet', 'walk', 'exercise', 'दवाई', 'योग', 'pranayam', 'reminder'],
  social_connection: ['friend', 'neighbour', 'community', 'milna', 'संगत', 'मिलना']
};

const countMatches = (text: string, terms: string[]): number => {
  let count = 0;
  for (const term of terms) {
    if (text.includes(term)) count += 1;
  }
  return count;
};

export const clamp = (value: number, min = 0, max = 100): number => Math.max(min, Math.min(max, Math.round(value)));

export const scoreBandFromOverall = (overallScore: number): ScoreBand => {
  if (overallScore >= 65) return 'stable';
  if (overallScore >= 45) return 'watch';
  return 'concern';
};

export const confidenceToLabel = (confidence: number): 'low' | 'medium' | 'high' => {
  if (confidence >= 75) return 'high';
  if (confidence >= 45) return 'medium';
  return 'low';
};

export const extractSignalFeatures = (normalizedText: string): ExtractedSignalFeatures => {
  const text = normalizedText.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  const topicCounts: Record<string, number> = {};
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const hits = countMatches(text, keywords);
    if (hits > 0) topicCounts[topic] = hits;
  }

  return {
    wordCount: words.length,
    questionCount: (text.match(/\?/g) ?? []).length,
    pauseMarkerCount: (text.match(/[.,;:|।]/g) ?? []).length,
    exclamationCount: (text.match(/!/g) ?? []).length,
    positiveHits: countMatches(text, POSITIVE_TERMS),
    negativeHits: countMatches(text, NEGATIVE_TERMS),
    distressHits: countMatches(text, DISTRESS_TERMS),
    confusionHits: countMatches(text, CONFUSION_TERMS),
    socialHits: countMatches(text, SOCIAL_TERMS),
    familyHits: countMatches(text, FAMILY_TERMS),
    adherenceHits: countMatches(text, ADHERENCE_TERMS),
    topics: Object.keys(topicCounts),
    topicCounts
  };
};

export const computeProsodyProxy = (features: ExtractedSignalFeatures): {
  speechRateProxy: number;
  pauseRatioProxy: number;
  energyVarianceProxy: number;
  prosodyCompleteness: number;
} => {
  const speechRateProxy = clamp(35 + features.wordCount * 3 - features.pauseMarkerCount * 2);
  const pauseRatioProxy = clamp(features.pauseMarkerCount * 12 - features.wordCount * 1.2 + 50);
  const energyVarianceProxy = clamp(features.exclamationCount * 18 + features.questionCount * 12 + 30);

  const prosodyCompleteness = clamp(
    25 +
      Math.min(30, features.wordCount * 1.5) +
      Math.min(25, features.pauseMarkerCount * 6) +
      Math.min(20, (features.exclamationCount + features.questionCount) * 8)
  );

  return {
    speechRateProxy,
    pauseRatioProxy,
    energyVarianceProxy,
    prosodyCompleteness
  };
};

export const computeDomainScores = (features: ExtractedSignalFeatures): {
  engagementScore: number;
  emotionalToneScore: number;
  socialConnectionScore: number;
  adherenceScore: number;
  distressScore: number;
  overallScore: number;
} => {
  const engagementScore = clamp(
    34 +
      Math.min(34, features.wordCount * 2) +
      Math.min(10, features.questionCount * 5) +
      Math.min(10, features.topics.length * 3)
  );

  const emotionalToneScore = clamp(50 + features.positiveHits * 12 - features.negativeHits * 10 - features.distressHits * 6);

  const socialConnectionScore = clamp(28 + features.socialHits * 12 + features.familyHits * 10 + Math.min(8, features.questionCount * 2));

  const adherenceScore = clamp(30 + features.adherenceHits * 14 - features.confusionHits * 6);

  const distressScore = clamp(18 + features.distressHits * 20 + features.confusionHits * 12 + Math.max(0, features.negativeHits - features.positiveHits) * 6);

  const overallScore = clamp(
    engagementScore * 0.3 +
      emotionalToneScore * 0.25 +
      socialConnectionScore * 0.2 +
      adherenceScore * 0.15 +
      (100 - distressScore) * 0.1
  );

  return {
    engagementScore,
    emotionalToneScore,
    socialConnectionScore,
    adherenceScore,
    distressScore,
    overallScore
  };
};

export const computeSignalConfidence = (input: {
  features: ExtractedSignalFeatures;
  languageNormalizationConfidence: number;
  prosodyCompleteness: number;
  priorTurnsToday: number;
}): { confidence: number; dataSufficiency: number } => {
  const lexicalCoverage = clamp(20 + input.features.wordCount * 3 + input.features.topics.length * 8);
  const continuity = clamp(20 + input.priorTurnsToday * 12);
  const prosody = clamp(input.prosodyCompleteness);

  const dataSufficiency = clamp(lexicalCoverage * 0.6 + continuity * 0.4);
  const confidence = clamp(
    lexicalCoverage * 0.35 +
      continuity * 0.25 +
      input.languageNormalizationConfidence * 0.3 +
      prosody * 0.1
  );

  return { confidence, dataSufficiency };
};

export const smoothScore = (current: number, previous?: number | null, alpha = 0.65): number => {
  if (previous === undefined || previous === null) return clamp(current);
  return clamp(alpha * current + (1 - alpha) * previous);
};

export const toIsoDateKey = (date: Date, timeZone = 'Asia/Kolkata'): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(date);
};

export const dateKeyToEpochMs = (dateKey: string): number => {
  const date = new Date(`${dateKey}T12:00:00+05:30`);
  return date.getTime();
};
