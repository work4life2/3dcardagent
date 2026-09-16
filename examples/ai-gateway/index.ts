// Vercel AI Gateway smoke test.
//   AI_GATEWAY_API_KEY lives in .env.local (git-ignored). Run from the project root:
//   node --env-file=.env.local --experimental-strip-types examples/ai-gateway/index.ts
import { generateText } from "ai";

const { text, usage } = await generateText({
  model: "openai/gpt-5.5",
  prompt: "Invent a brand-new holiday. Give it a name, the date it is celebrated, and describe three of its traditions.",
});

console.log(text);
console.log(`\n[usage] input=${usage.inputTokens} output=${usage.outputTokens}`);
