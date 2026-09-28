import type { JSONValue, LanguageModel } from "ai";

// How much a reasoning model "thinks" per call. Grading picks a tier per batch
// of questions (bigger questions think more); small bookkeeping calls use
// "light". Each tier becomes the provider's own option.
//   AI_REASONING=auto (default) | off (every call uses the provider's default)

export const REASONING_TIERS = ["light", "medium", "high", "max"] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];

type ProviderOptions = Record<string, Record<string, JSONValue>>;

export function reasoningEnabled(): boolean {
  const value = process.env.AI_REASONING?.trim().toLowerCase() || "auto";
  if (!["auto", "off"].includes(value)) throw new Error(`AI_REASONING must be auto or off (got "${value}").`);
  return value === "auto";
}

/**
 * The provider options for a tier, or undefined when the provider has no such
 * setting (or it isn't known to be safe, e.g. an arbitrary OpenAI-compatible
 * endpoint unless OPENAI_COMPATIBLE_REASONING=on).
 */
export function reasoningOptions(model: LanguageModel, tier: ReasoningTier): ProviderOptions | undefined {
  if (typeof model === "string") return undefined;
  const provider = model.provider.split(".")[0];
  const pick = <T,>(values: Record<ReasoningTier, T>) => values[tier];
  switch (provider) {
    case "deepseek":
      // DeepSeek has three levels.
      return { deepseek: { reasoningEffort: pick({ light: "low", medium: "high", high: "high", max: "max" }) } };
    case "openai":
      return { openai: { reasoningEffort: pick({ light: "low", medium: "medium", high: "high", max: "xhigh" }) } };
    case "anthropic":
      return { anthropic: { effort: pick({ light: "low", medium: "medium", high: "high", max: "xhigh" }) } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: pick({ light: "low", medium: "medium", high: "high", max: "high" }) } } };
    case "openrouter":
      return { openrouter: { reasoning: { effort: pick({ light: "low", medium: "medium", high: "high", max: "xhigh" }) } } };
    case "groq":
      return { groq: { reasoningEffort: pick({ light: "low", medium: "medium", high: "high", max: "high" }) } };
    case "compatible":
      return process.env.OPENAI_COMPATIBLE_REASONING?.trim().toLowerCase() === "on"
        ? { compatible: { reasoningEffort: pick({ light: "low", medium: "medium", high: "high", max: "high" }) } }
        : undefined;
    default:
      return undefined;
  }
}

/** What a grading batch holds, for choosing its tier. */
export type GradingLoad = {
  /** Marks of the questions that have an answer to grade. */
  answeredMarks: number[];
  /** Length of those answers, in characters. */
  answerChars: number[];
  /** A 5+ mark question asking to prove, derive, construct, design, convert or draw. */
  complex: boolean;
};

/** Answers longer than this on average count as long work. */
const LONG_ANSWER_CHARS = 1500;

/**
 * Tier from the average marks of the batch's answered questions, one level up
 * for long answers or construction/proof questions:
 *   <=2 marks light · <=5 medium · <=8 high · more max. Unanswered-only: light.
 */
export function gradingTier(load: GradingLoad): ReasoningTier {
  if (!load.answeredMarks.length) return "light";
  const average = load.answeredMarks.reduce((sum, marks) => sum + marks, 0) / load.answeredMarks.length;
  let level = average <= 2 ? 0 : average <= 5 ? 1 : average <= 8 ? 2 : 3;
  const averageChars = load.answerChars.reduce((sum, chars) => sum + chars, 0) / Math.max(1, load.answerChars.length);
  if (load.complex || averageChars > LONG_ANSWER_CHARS) level += 1;
  return REASONING_TIERS[Math.min(level, REASONING_TIERS.length - 1)];
}

/** Construction and proof wording that deserves more thought when worth 5+ marks. */
export const COMPLEX_QUESTION = /\b(prove|derive|construct|design|convert|draw|show that|justify)\b/i;
