import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { userProfiles } from '../../db/schema.js';
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
  getQuestions(): OnboardingQuestion[] {
    return DEFAULT_QUESTIONS;
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
    if (!row) return null;
    return {
      userId,
      answers: row.answers,
      updatedAt: row.updatedAt.getTime()
    };
  }

  async hasCompletedOnboarding(userId: string): Promise<boolean> {
    const profile = await this.getProfile(userId);
    if (!profile) return false;

    const a = profile.answers;
    return Boolean(a['elderName']) && Boolean(a['elderLanguage']);
  }

  async saveAnswers(userId: string, answers: Record<string, string>): Promise<UserProfile> {
    const normalizedAnswers = { ...answers };
    if (typeof normalizedAnswers.language === 'string' && normalizedAnswers.language.trim()) {
      normalizedAnswers.language = normalizeLanguageCode(normalizedAnswers.language, 'hi-IN');
    }

    const existing = await this.getProfile(userId);
    const mergedAnswers = {
      ...(existing?.answers ?? {}),
      ...normalizedAnswers
    };

    if (!existing) {
      const [created] = await db
        .insert(userProfiles)
        .values({
          userId,
          answers: mergedAnswers,
          updatedAt: new Date()
        })
        .returning();
      return {
        userId,
        answers: created.answers,
        updatedAt: created.updatedAt.getTime()
      };
    }

    const [updated] = await db
      .update(userProfiles)
      .set({
        answers: mergedAnswers,
        updatedAt: new Date()
      })
      .where(eq(userProfiles.userId, userId))
      .returning();

    return {
      userId,
      answers: updated.answers,
      updatedAt: updated.updatedAt.getTime()
    };
  }
}
