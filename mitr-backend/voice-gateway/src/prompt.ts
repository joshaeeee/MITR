import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import type { DeviceAuthContext } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_PATH = join(__dirname, "prompts", "mitr_system_prompt.md");

let cachedTemplate: string | null = null;

function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  const path = config.claudeSystemPromptPath || DEFAULT_PROMPT_PATH;
  cachedTemplate = readFileSync(path, "utf8");
  return cachedTemplate;
}

/** Human-friendly language name for the prompt's {auth.language} slot. */
function languageLabel(tag: string): string {
  const base = (tag || "hi-IN").toLowerCase();
  if (base.startsWith("hi")) return "Hindi/Hinglish (hi-IN)";
  if (base.startsWith("en")) return "English (en-IN)";
  if (base.startsWith("ta")) return "Tamil";
  if (base.startsWith("te")) return "Telugu";
  if (base.startsWith("bn")) return "Bengali";
  if (base.startsWith("mr")) return "Marathi";
  if (base.startsWith("gu")) return "Gujarati";
  if (base.startsWith("kn")) return "Kannada";
  if (base.startsWith("ml")) return "Malayalam";
  if (base.startsWith("pa")) return "Punjabi";
  return tag;
}

/**
 * Render the system instruction for a session: substitute {auth.language} and
 * append a small runtime-context block (mirrors the Pipecat _system_instruction).
 */
export function renderSystemPrompt(auth: DeviceAuthContext, now: Date = new Date()): string {
  const template = loadTemplate();
  const body = template.replaceAll("{auth.language}", languageLabel(auth.language));

  const tz = auth.timezone || "Asia/Kolkata";
  let when = "";
  try {
    when = new Intl.DateTimeFormat("en-IN", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tz,
    }).format(now);
  } catch {
    when = now.toISOString();
  }

  const ctx: string[] = ["", "# Runtime context", `Current time: ${when} (${tz}).`];
  if (auth.userName) ctx.push(`You are speaking with ${auth.userName}.`);
  else if (auth.elderName) ctx.push(`You are speaking with ${auth.elderName}.`);
  ctx.push("Respond as if speaking out loud. Keep it brief and natural.");

  return body + "\n" + ctx.join("\n") + "\n";
}
