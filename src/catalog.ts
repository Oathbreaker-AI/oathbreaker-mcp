// Fixed facts about the tools. Prices, limits and the model list are read live
// from https://oathbreaker.ai/api/config, so a price change on the site needs
// no new release here. Only the one-line notes below are kept in this file;
// a model without a note still works and is listed.

export const SITE = "https://oathbreaker.ai";
export const DEFAULT_MODEL = "oathbreaker-glm-5.3-flash";
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_EFFORT = "low" as const;
/** Generations one API key may run at once through MCP. */
export const MCP_SLOTS_PER_KEY = 2;

export const LINKS = {
  keys: `${SITE}/dashboard`,
  credits: `${SITE}/credits`,
  setup: `${SITE}/agents/mcp`,
  terms: `${SITE}/terms`,
  docs: `${SITE}/docs`,
  pricing: `${SITE}/pricing`,
};

export const MODEL_NOTES: Record<string, string> = {
  "oathbreaker-glm-5.3": "Strongest general model for coding, analysis and long answers.",
  "oathbreaker-glm-5.3-flash": "Fast and low-cost; the default for quick questions.",
  "oathbreaker-deepseek-v4.1-flash": "Low-cost alternative with a different style; good for a second opinion.",
  "oathbreaker-deepseek-v4.1-flash-fast": "DeepSeek V4.1 Flash on faster serving, at a slightly higher price.",
  "oathbreaker-kimi-k3.1-pro": "Most capable model for hard reasoning and agentic work; highest price.",
};

export const EFFORTS = ["low", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
