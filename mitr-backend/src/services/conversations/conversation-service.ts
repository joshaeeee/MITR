import { db } from '../../db/client.js';
import { conversationTurns } from '../../db/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ConversationService {
  isSupportedUserId(userId: string): boolean {
    return UUID_RE.test(userId);
  }

  async appendTurn(input: {
    sessionId: string;
    userId: string;
    userText: string;
    assistantText: string;
    language?: string;
    citations?: Array<Record<string, unknown>>;
  }): Promise<void> {
    if (!this.isSupportedUserId(input.userId)) return;
    const trimmedUser = input.userText.trim();
    const trimmedAssistant = input.assistantText.trim();
    if (!trimmedUser || !trimmedAssistant) return;

    await db.insert(conversationTurns).values({
      sessionId: input.sessionId,
      userId: input.userId,
      userText: trimmedUser,
      assistantText: trimmedAssistant,
      language: input.language,
      citations: input.citations ?? []
    });
  }
}
