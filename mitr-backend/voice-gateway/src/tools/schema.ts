import type { AnthropicTool } from "../types.js";

// A curated, accurate subset of the Mitr tool surface in Anthropic tool-use shape.
// The mitr-backend is the source of truth for execution; descriptions here are
// behaviorally binding for the model (mirrors the Pipecat prompt's contract).
//
// NOTE: The full Pipecat surface is ~45 tools (see pipecat-gateway/.../tools.py
// build_tools_schema). The backend bridge executes ANY tool name, so adding the
// rest is purely a matter of appending schemas here — no execution changes needed.

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): AnthropicTool["input_schema"] => ({ type: "object", properties, required });

export const TOOL_SCHEMAS: AnthropicTool[] = [
  {
    name: "web_search",
    description:
      "Search the live web for current, factual, or time-sensitive information the user asks about (news events, facts, prices, definitions, 'what is', 'who is', current affairs). Use when an answer requires up-to-date information you do not already know. Do NOT use for personal memories or reminders.",
    input_schema: obj(
      {
        query: { type: "string", description: "The search query, in the user's language or English." },
      },
      ["query"],
    ),
  },
  {
    name: "news_retrieve",
    description:
      "Fetch recent news headlines/summaries on a topic or category the user asks about (e.g. cricket, politics, their city). Prefer this over web_search for 'what's the news' style requests.",
    input_schema: obj({
      topic: { type: "string", description: "News topic or category." },
      language: { type: "string", description: "Optional language code, e.g. hi-IN." },
    }),
  },
  {
    name: "memory_add",
    description:
      "Silently save a durable fact the user shares about themselves, their family, preferences, health, or routine (e.g. 'my granddaughter's name is Aanya', 'I take BP medicine at 8am'). Call without announcing it and continue the conversation naturally. Do not use for transient chit-chat.",
    input_schema: obj(
      {
        content: { type: "string", description: "The fact to remember, in a concise sentence." },
      },
      ["content"],
    ),
  },
  {
    name: "memory_get",
    description:
      "Retrieve previously saved facts about the user relevant to the current conversation (names, preferences, routines, health notes). Use when recalling personal context would make the reply better.",
    input_schema: obj({
      query: { type: "string", description: "What to recall, e.g. 'family members' or 'medications'." },
    }),
  },
  {
    name: "reminder_create",
    description:
      "Create a reminder for the user at a specific time (medication, appointment, call, task). Confirm the time and subject before creating if at all ambiguous.",
    input_schema: obj(
      {
        title: { type: "string", description: "What to remind the user about." },
        when: { type: "string", description: "Natural-language time, e.g. 'kal subah 8 baje' or '2026-06-10T08:00'." },
      },
      ["title", "when"],
    ),
  },
  {
    name: "reminder_list",
    description: "List the user's upcoming reminders. Use when they ask what's scheduled or to review reminders.",
    input_schema: obj({}),
  },
  {
    name: "daily_briefing_get",
    description:
      "Get the user's personalized daily briefing (weather, day summary, anything scheduled). Use for 'aaj ka din kaisa hai', 'good morning', or start-of-day requests.",
    input_schema: obj({}),
  },
  {
    name: "panchang_get",
    description:
      "Get today's Hindu panchang / tithi / festival/auspicious-time information. Use for religious calendar questions (tithi, muhurat, vrat, festival dates).",
    input_schema: obj({
      date: { type: "string", description: "Optional date YYYY-MM-DD; defaults to today." },
    }),
  },
  {
    name: "story_retrieve",
    description:
      "Fetch a story (mythological, moral, folk) to narrate when the user asks to hear a story (kahani sunao). Returns story text to read aloud.",
    input_schema: obj({
      theme: { type: "string", description: "Optional theme/character, e.g. 'Krishna', 'panchatantra'." },
    }),
  },
  {
    name: "youtube_media_get",
    description:
      "Find a song / bhajan / video the user asks to play. Returns media references the device can play. Use for 'gaana sunao', 'bhajan chalao', specific song requests.",
    input_schema: obj(
      {
        query: { type: "string", description: "Song/bhajan/artist the user wants." },
      },
      ["query"],
    ),
  },
];
