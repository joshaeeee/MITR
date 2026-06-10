// Faithful port of the Pipecat UnicodeWakePhraseUserTurnStartStrategy matcher.
// NFC-normalize, strip punctuation/symbols, dual rolling buffers (spaced + compact),
// \s*-joined words with unicode-aware word boundaries, alias expansion gated on the
// configured triggers, IGNORECASE. Designed to match on fragmented interim transcripts.

const BUF_LIMIT = 250;

function stripPunctuation(text: string): string {
  // Keep whitespace; replace any Punctuation/Symbol/Other char with a space.
  return text.normalize("NFC").replace(/[\p{P}\p{S}\p{C}]/gu, " ");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(phrase: string): RegExp {
  const normalized = stripPunctuation(phrase).trim();
  const body = normalized.split(/\s+/).filter(Boolean).map(escapeRegex).join("\\s*");
  // Unicode-aware boundaries (\p{L}\p{N}_) mirror Python's unicode \w.
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Expand configured triggers into STT-misrecognition aliases (gated on configuration). */
export function expandWakeAliases(configured: string[]): string[] {
  const aliases = new Set(configured);
  const normalized = new Set(configured.map((p) => stripPunctuation(p).trim().toLowerCase()));

  const addIfConfigured = (triggers: string[], extra: string[]) => {
    if (triggers.some((t) => normalized.has(t))) extra.forEach((e) => aliases.add(e));
  };

  addIfConfigured(
    ["hi esp", "hey esp", "hi e s p", "hey e s p"],
    ["हाय ईएसपी", "हे ईएसपी", "हाय ई एस पी", "हे ई एस पी"],
  );
  addIfConfigured(
    ["hi reca", "hey reca", "hi reka", "hey reka", "hi rekha", "hey rekha"],
    [
      // Devanagari renderings. Saaras splits/varies the name ("रे का", "रका"); writing the
      // split form also covers the joined one because words are \s*-joined in the pattern.
      "हाय रे का", "हे रे का", "हाय रेखा", "हे रेखा", "हाय रका", "हे रका",
      // Mixed-script renderings (Saaras emits e.g. "हाय Rekha").
      "हाय reca", "हे reca", "हाय reka", "हे reka", "हाय rekha", "हे rekha",
      "hi रेका", "hey रेका", "hi रेखा", "hey रेखा",
      // "हाय" romanized as "hay".
      "hay reca", "hay reka", "hay rekha", "hay रेका", "hay रेखा",
    ],
  );
  addIfConfigured(["hi r e k a", "hey r e k a"], ["हाय आर ई के ए", "हे आर ई के ए"]);
  addIfConfigured(
    ["hi mitr", "hey mitr", "hi mitra", "hey mitra"],
    [
      "hi meter", "hey meter", "hi miter", "hey miter",
      "hi mitter", "hey mitter", "hi mithra", "hey mithra",
      "hi meet her", "hey meet her",
      "hi mater", "hey mater", "hi matter", "hey matter", // Sarvam Saaras renders "Mitr" as "Mater"
      "hi mitra ji", "hey mitra ji",
      "हाय मित्र", "हे मित्र", "हाय मित्रा", "हे मित्रा",
      // Mixed-script renderings (Devanagari greeting + Latin name, and vice versa).
      "हाय mitr", "हे mitr", "हाय mitra", "हे mitra", "हाय meter", "हे meter",
      "hi मित्र", "hey मित्र", "hi मित्रा", "hey मित्रा",
      // "हाय" romanized as "hay".
      "hay mitr", "hay mitra", "hay meter", "hay mater", "hay मित्र", "hay मित्रा",
    ],
  );

  // Longest first so the most specific phrase wins.
  return [...aliases].filter((p) => p.trim()).sort((a, b) => b.length - a.length);
}

export class WakeMatcher {
  readonly phrases: string[];
  private readonly patterns: RegExp[];
  private readonly cleanedPhrases: Set<string>;
  private readonly maxPhraseWords: number;
  private accumulated = "";
  private compact = "";

  constructor(configuredPhrases: string[]) {
    this.phrases = expandWakeAliases(configuredPhrases);
    this.patterns = this.phrases.map(buildPattern);
    const cleaned = this.phrases.map((p) =>
      stripPunctuation(p).trim().toLowerCase().replace(/\s+/g, " "),
    );
    this.cleanedPhrases = new Set(cleaned);
    this.maxPhraseWords = cleaned.reduce((m, p) => Math.max(m, p.split(" ").length), 1);
  }

  /**
   * If `raw` begins with a known wake phrase, return the remainder (the actual query);
   * otherwise return `raw` unchanged. Word-level so punctuation/spacing don't matter.
   */
  stripLeadingWake(raw: string): string {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    for (let k = Math.min(this.maxPhraseWords, words.length); k >= 1; k--) {
      const prefix = stripPunctuation(words.slice(0, k).join(" "))
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      if (this.cleanedPhrases.has(prefix)) {
        return words.slice(k).join(" ").trim();
      }
    }
    return raw.trim();
  }

  /**
   * Feed an STT transcript chunk (interim or final). Returns the matched phrase
   * string if a wake phrase is now present in either rolling buffer, else null.
   */
  feed(text: string): string | null {
    const clean = stripPunctuation(text);
    this.accumulated = (this.accumulated + " " + clean).slice(-BUF_LIMIT);
    this.compact = (this.compact + clean).slice(-BUF_LIMIT);

    for (let i = 0; i < this.patterns.length; i++) {
      const p = this.patterns[i]!;
      if (p.test(this.accumulated) || p.test(this.compact)) {
        return this.phrases[i]!;
      }
    }
    return null;
  }

  reset(): void {
    this.accumulated = "";
    this.compact = "";
  }
}
