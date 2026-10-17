import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { SupportAgent } from "../src/agent.ts";
import { Knowledge } from "../src/knowledge.ts";
import { GroqProvider, ProviderError } from "../src/provider.ts";
import { Store } from "../src/store.ts";

async function readSecret(): Promise<string> {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  console.log("Ready for Groq key on stdin (input hidden).");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  const key = await new Promise<string>((resolve) => {
    let buffer = "";
    const listener = (part: Buffer) => {
      buffer += part.toString();
      if (/[\r\n]/.test(buffer)) {
        process.stdin.off("data", listener);
        resolve(buffer.trim());
      }
    };
    process.stdin.on("data", listener);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  return key;
}
let key = await readSecret();
if (!key) throw Error("GROQ_API_KEY is required.");
const store = new Store(":memory:");
try {
  if (process.argv.includes("--list-models")) {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data: any = await response.json();
    if (!response.ok)
      throw Error(`Model discovery failed: HTTP ${response.status}`);
    console.log(
      JSON.stringify(
        data.data.map((m: any) => ({
          id: m.id,
          contextWindow: m.context_window,
        })),
        null,
        2,
      ),
    );
  } else {
    const provider = new GroqProvider(key),
      knowledge = Knowledge.load(),
      agent = new SupportAgent(store, knowledge, provider);
    const principal = { id: "live-eval", tenant: "demo", scopes: ["it"] };
    const cases = [
      "Windows VPN 809 hatası",
      "Yeni telefon aldım MFA uygulamasına erişemiyorum",
    ];
    const prior = process.argv.includes("--reuse-baseline")
      ? JSON.parse(readFileSync("evidence/live-groq.json", "utf8"))
      : null;
    if (
      prior &&
      (prior.model !== provider.model ||
        JSON.stringify(prior.results.map((r: any) => r.question)) !==
          JSON.stringify(cases))
    )
      throw Error("Prior baseline does not match this protocol.");
    const results = [];
    for (const [i, question] of cases.entries()) {
      const baseline = prior
        ? prior.results[i].baseline
        : await provider.complete(
            [
              {
                role: "system",
                content:
                  'You are an IT support assistant. Use only the supplied authorized runbooks. Answer in Turkish. Return JSON {"answer":"brief steps","citationIds":["source id"]}. Never ask for passwords or MFA codes.',
              },
              {
                role: "user",
                content: JSON.stringify({
                  question,
                  evidence: knowledge.allowed(principal),
                }),
              },
            ],
            384,
            false,
          );
      const optimized = await agent.handle({
        principal,
        channel: "api",
        conversation: String(i),
        eventId: "first",
        message: question,
      });
      if (i === 1 && optimized.route !== "rag")
        throw Error(
          "Live grounded generation did not complete: " + optimized.text,
        );
      results.push({
        question,
        baseline: { usage: baseline.usage, answer: baseline.content },
        optimized,
      });
    }
    const cache = await agent.handle({
      principal,
      channel: "api",
      conversation: "1",
      eventId: "repeat",
      message: cases[1],
    });
    const baseTokens = results.reduce(
      (n, r) => n + r.baseline.usage.input + r.baseline.usage.output,
      0,
    );
    const optimizedTokens = results.reduce(
      (n, r) => n + r.optimized.usage.input + r.optimized.usage.output,
      0,
    );
    const report = {
      measuredAt: new Date().toISOString(),
      model: provider.model,
      baselineMeasuredAt: prior?.measuredAt ?? null,
      scope:
        "Two synthetic requests, identical model/output cap; baseline sends all authorized runbooks. Not evidence of production resolution rate.",
      baseTokens,
      optimizedTokens,
      tokenReductionPercent: Number(
        ((1 - optimizedTokens / baseTokens) * 100).toFixed(1),
      ),
      cache: { route: cache.route, usage: cache.usage },
      results,
    };
    mkdirSync("evidence", { recursive: true });
    writeFileSync(
      "evidence/live-groq.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(
    error instanceof ProviderError
      ? error.code
      : error instanceof Error
        ? error.message
        : "Live check failed",
  );
  process.exitCode = 1;
} finally {
  key = "";
  store.close();
}
