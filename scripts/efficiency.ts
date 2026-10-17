import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Knowledge } from "../src/knowledge.ts";
import { SupportAgent } from "../src/agent.ts";
import { Store } from "../src/store.ts";
import { SEARCH_TOOL } from "../src/provider.ts";
import type {
  Completion,
  ModelMessage,
  Provider,
  Runbook,
} from "../src/contracts.ts";

// Offline structural benchmark: mocks deliberately report no billed tokens.
// Request bytes and calls are measured, never converted into estimated tokens.
const question = "Yeni telefon aldım MFA uygulamasına erişemiyorum";
const principal = { id: "efficiency-eval", tenant: "demo", scopes: ["it"] };
const result = (): Completion => ({
  content: JSON.stringify({
    answer:
      "Onaylı kurtarma yöntemini kontrol et; kod paylaşma. Gerekirse IT desteğine başvur.",
    citationIds: ["mfa-device:1"],
  }),
  toolCalls: [],
  usage: { input: 0, output: 0, cachedInput: 0, calls: 1 },
});
async function exercise(Agent: typeof SupportAgent, Corpus: typeof Knowledge) {
  const requests: { contentBytes: number; tools: boolean }[] = [];
  let toolMode = false,
    toolIssued = false;
  const provider: Provider = {
    async complete(messages: ModelMessage[], maxOutput, tools) {
      requests.push({
        contentBytes: Buffer.byteLength(
          JSON.stringify({
            messages,
            maxOutput,
            ...(tools ? { tools: [SEARCH_TOOL] } : {}),
          }),
        ),
        tools,
      });
      if (toolMode && !toolIssued) {
        toolIssued = true;
        return {
          ...result(),
          content: null,
          toolCalls: [
            {
              id: "search",
              type: "function",
              function: {
                name: "search_knowledge",
                arguments: '{"query":"MFA telefon kurtarma"}',
              },
            },
          ],
        };
      }
      return result();
    },
  };
  const store = new Store(":memory:");
  try {
    const agent = new Agent(store, Corpus.load(), provider);
    const routes: string[] = [];
    let event = 0;
    for (const message of [
      question,
      question.toLocaleLowerCase("tr-TR"),
      question.replaceAll(" ", "   "),
    ]) {
      const response = await agent.handle({
        principal,
        channel: "api",
        conversation: "repeats",
        eventId: String(++event),
        message,
      });
      assert.ok(response.route === "rag" || response.route === "cache");
      assert.equal(response.citations[0]?.id, "mfa-device:1");
      routes.push(response.route);
    }
    const repeatRequests = requests.splice(0);
    toolMode = true;
    const response = await agent.handle({
      principal,
      channel: "api",
      conversation: "tool",
      eventId: "tool",
      message: "MFA Outlook erişim sorunları",
    });
    assert.equal(response.route, "rag");
    return {
      firstRequestContentBytes: repeatRequests[0].contentBytes,
      repeatedVariants: {
        routes,
        mockModelCalls: repeatRequests.length,
        totalContentBytes: repeatRequests.reduce(
          (n, r) => n + r.contentBytes,
          0,
        ),
      },
      retrievalTool: {
        mockModelCalls: requests.length,
        totalContentBytes: requests.reduce((n, r) => n + r.contentBytes, 0),
      },
    };
  } finally {
    store.close();
  }
}
function retrieval(Corpus: typeof Knowledge, books: Runbook[]) {
  const k = new Corpus(books);
  const query = "MFA telefon kurtarma";
  k.search(principal, query); // Warm-up; construction and cold-start excluded.
  const timings: number[] = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    k.search(principal, query);
    timings.push(performance.now() - start);
  }
  return {
    medianMs: Number(timings.sort((a, b) => a - b)[3].toFixed(3)),
    top3: k.search(principal, query).map((c) => c.id),
  };
}
const books = Knowledge.load().books.filter(
  (b) => b.tenant === "demo" && b.scope === "it",
);
const large = Array.from({ length: 800 }, (_, i) => ({
  ...books[i % books.length],
  id: `${books[i % books.length].id}-${i}`,
  tenant: i % 5 === 0 ? "other-company" : "demo",
}));
const optimized = {
  flow: await exercise(SupportAgent, Knowledge),
  retrieval: retrieval(Knowledge, large),
};
const index = process.argv.indexOf("--baseline");
let baseline;
if (index >= 0) {
  assert.ok(
    process.argv[index + 1],
    "Pass the local baseline checkout directory.",
  );
  const root = resolve(process.argv[index + 1]);
  const { SupportAgent: BeforeAgent } = await import(
    pathToFileURL(resolve(root, "src/agent.ts")).href
  );
  const { Knowledge: BeforeKnowledge } = await import(
    pathToFileURL(resolve(root, "src/knowledge.ts")).href
  );
  baseline = {
    flow: await exercise(BeforeAgent, BeforeKnowledge),
    retrieval: retrieval(BeforeKnowledge, large),
  };
  assert.deepEqual(
    optimized.retrieval.top3,
    baseline.retrieval.top3,
    "Ranking must remain unchanged.",
  );
}
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      mode: "offline-mocked-provider",
      scope:
        "Same synthetic queries and full source text; measures UTF-8 request content bytes, mock call counts and warm retrieval time. No live tokens, answer-quality or production latency claim.",
      retrievalDataset: {
        documents: large.length,
        samples: 7,
        constructionExcluded: true,
      },
      ...(baseline
        ? {
            baseline,
            firstRequestByteReductionPercent: Number(
              (
                (1 -
                  optimized.flow.firstRequestContentBytes /
                    baseline.flow.firstRequestContentBytes) *
                100
              ).toFixed(1),
            ),
            warmRetrievalSpeedup: Number(
              (
                baseline.retrieval.medianMs / optimized.retrieval.medianMs
              ).toFixed(1),
            ),
          }
        : {}),
      optimized,
    },
    null,
    2,
  ),
);
