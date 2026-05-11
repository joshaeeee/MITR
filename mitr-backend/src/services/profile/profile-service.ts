import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { userProfiles } from '../../db/schema.js';
import { normalizeLanguageCode } from '../../lib/language.js';

export interface OnboardingQuestion {
  id: string;
  prompt: string;
  type: 'text' | 'number' | 'choice';
  required: boolean;
  choices?: string[];
}

export interface UserProfile {
  userId: string;
  answers: Record<string, string>;
  updatedAt: number;
}

const DEFAULT_QUESTIONS: OnboardingQuestion[] = [
  { id: 'elderName', prompt: 'Aapka naam kya hai?', type: 'text', required: true },
  {
    id: 'elderAgeRange',
    prompt: 'Aapki age range kya hai?',
    type: 'choice',
    required: false,
    choices: ['60-69', '70-79', '80+']
  },
  { id: 'elderCity', prompt: 'Aap kis shehar ya region se hain?', type: 'text', required: false },
  { id: 'elderLanguage', prompt: 'Aap kis bhasha mein baat karna pasand karenge?', type: 'text', required: true },
  { id: 'preferredAddress', prompt: 'Reca aapko kis naam se bulaye?', type: 'text', required: false },
  {
    id: 'firstUseCases',
    prompt: 'Pehle hafte Reca kin 2-3 cheezon mein madad kare?',
    type: 'text',
    required: false
  },
  {
    id: 'routineAnchors',
    prompt: 'Roz ke fixed routine kya hain? Jaise chai, nashta, dawa, puja, walk, TV news.',
    type: 'text',
    required: false
  },
  {
    id: 'boundaries',
    prompt: 'Koi topic jo Reca ko avoid karna chahiye?',
    type: 'text',
    required: false
  },
  {
    id: 'proactiveLevel',
    prompt: 'Reca kitni baar khud se baat shuru kare?',
    type: 'choice',
    required: false,
    choices: ['low', 'medium', 'high']
  }
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
    if (typeof normalizedAnswers.elderLanguage === 'string' && normalizedAnswers.elderLanguage.trim()) {
      normalizedAnswers.elderLanguage = normalizeLanguageCode(normalizedAnswers.elderLanguage, 'hi-IN');
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
