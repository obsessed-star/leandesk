import { defineAgent } from "eve";
import { createGroq } from "@ai-sdk/groq";
export default defineAgent({
  model: createGroq({ apiKey: process.env.GROQ_API_KEY })(
    process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b",
  ),
  tool: false,
  modelContextWindowTokens: 8192,
  limits: { maxInputTokensPerSession: 18_000, maxOutputTokensPerSession: 768 },
});
