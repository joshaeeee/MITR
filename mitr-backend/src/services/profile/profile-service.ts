import { Redis } from 'ioredis';
import { getSharedRedisClient } from '../../lib/redis.js';
import { normalizeLanguageCode } from '../../lib/language.js';

export interface OnboardingQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'number' | 'choice';
  required: boolean;
}

export interface UserProfile {
  userId: string;
  answers: Record<string, string>;
  updatedAt: number;
}

const DEFAULT_QUESTIONS: OnboardingQuestion[] = [
  { id: 'name', prompt: 'Aapka naam kya hai?', type: 'text', required: true },
  { id: 'age', prompt: 'Aapki umar kya hai?', type: 'number', required: false },
  { id: 'region', prompt: 'Aap kis shehar ya region se hain?', type: 'text', required: false },
  { id: 'language', prompt: 'Aap kis bhasha mein baat karna pasand karenge?', type: 'text', required: true }
];

export class ProfileService {
  private redis?: Redis;
  private memory = new Map<string, UserProfile>();

  constructor() {
    this.redis = getSharedRedisClient() ?? undefined;
  }

  getQuestions(): OnboardingQuestion[] {
    return DEFAULT_QUESTIONS;
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    if (this.redis) {
      const raw = await this.redis.get(`profile:${userId}`);
      return raw ? (JSON.parse(raw) as UserProfile) : null;
    }
    return this.memory.get(userId) ?? null;
  }

  async hasCompletedOnboarding(userId: string): Promise<boolean> {
    const profile = await this.getProfile(userId);
    if (!profile) return false;

    const required = this.getQuestions().filter((q) => q.required).map((q) => q.id);
    return required.every((key) => Boolean(profile.answers[key]));
  }

  async saveAnswers(userId: string, answers: Record<string, string>): Promise<UserProfile> {
    const normalizedAnswers = { ...answers };
    if (typeof normalizedAnswers.language === 'string' && normalizedAnswers.language.trim()) {
      normalizedAnswers.language = normalizeLanguageCode(normalizedAnswers.language, 'hi-IN');
    }

    const existing = await this.getProfile(userId);
    const merged: UserProfile = {
      userId,
      answers: {
        ...(existing?.answers ?? {}),
        ...normalizedAnswers
      },
      updatedAt: Date.now()
    };

    if (this.redis) {
      await this.redis.set(`profile:${userId}`, JSON.stringify(merged));
      return merged;
    }

    this.memory.set(userId, merged);
    return merged;
  }
}
