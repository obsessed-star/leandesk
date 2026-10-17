import test from "node:test";
import assert from "node:assert/strict";
import { Knowledge } from "../src/knowledge.ts";
import { Store } from "../src/store.ts";
import { SupportAgent } from "../src/agent.ts";
import type { ModelMessage, Provider, Runbook } from "../src/contracts.ts";

const principal = { id: "alice", tenant: "demo", scopes: ["it"] };
const question = "Yeni telefon aldım MFA uygulamasına erişemiyorum";
const final = (id = "mfa-device:1") => ({
  content: JSON.stringify({
    answer:
      "Onaylı kurtarma yöntemini kontrol et. Kod paylaşma; gerekirse IT desteğine başvur.",
    citationIds: [id],
  }),
  toolCalls: [],
  usage: { input: 1, output: 1, cachedInput: 0, calls: 1 },
});
function fixture(provider: Provider, knowledge = Knowledge.load()) {
  const store = new Store(":memory:"),
    agent = new SupportAgent(store, knowledge, provider);
  let id = 0;
  return {
    store,
    ask: (message = question, scopes = ["it"]) =>
      agent.handle({
        principal: { ...principal, scopes },
        channel: "api",
        conversation: "case",
        eventId: String(++id),
        message,
      }),
  };
}

test("compact prompt sends question once and full source text without nested encoding", async () => {
  let payload: any;
  const s = fixture({
    async complete(messages) {
      payload = JSON.parse(messages[1].content!);
      return final();
    },
  });
  await s.ask();
  assert.equal(payload.question, question);
  assert.equal(payload.case, undefined);
  assert.ok(Array.isArray(payload.evidence));
  const source = Knowledge.load()
    .allowed(principal)
    .find((c) => c.id === "mfa-device:1")!;
  assert.deepEqual(payload.evidence, [{ id: source.id, text: source.text }]);
  s.store.close();
});

test("case and whitespace variants hit cache without another model call", async () => {
  let calls = 0;
  const s = fixture({
    async complete() {
      calls++;
      return final();
    },
  });
  await s.ask();
  assert.equal(
    (await s.ask(question.toLocaleLowerCase("tr-TR"))).route,
    "cache",
  );
  assert.equal((await s.ask(question.replaceAll(" ", "   "))).route, "cache");
  assert.equal(calls, 1);
  s.store.close();
});

test("changed facts and denied scopes never reuse a cached answer", async () => {
  let calls = 0;
  const s = fixture({
    async complete() {
      calls++;
      return final();
    },
  });
  await s.ask();
  assert.equal(
    (await s.ask("Yeni telefon aldım MFA çalışmıyor; kurtarma yöntemi yok"))
      .route,
    "rag",
  );
  assert.equal((await s.ask(question, ["engineering"])).route, "clarify");
  assert.equal(calls, 2);
  s.store.close();
});

test("follow-up facts omit the current attempt but retain earlier failures", async () => {
  const captured: ModelMessage[][] = [];
  const s = fixture({
    async complete(messages) {
      captured.push(structuredClone(messages));
      return final();
    },
  });
  await s.ask();
  await s.ask("MFA başka ağda da çalışmıyor");
  await s.ask("MFA kurtarma seçeneği yok");
  const payload = JSON.parse(captured[2][1].content!);
  assert.equal(payload.question, "MFA kurtarma seçeneği yok");
  assert.deepEqual(payload.case, {
    issue: question,
    attempts: ["MFA başka ağda da çalışmıyor"],
  });
  s.store.close();
});

test("repeated retrieval returns an empty delta and keeps original citations valid", async () => {
  const calls: ModelMessage[][] = [];
  const s = fixture({
    async complete(messages) {
      calls.push(structuredClone(messages));
      return calls.length === 1
        ? {
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
            usage: { input: 1, output: 1, cachedInput: 0, calls: 1 },
          }
        : final();
    },
  });
  const result = await s.ask("MFA Outlook erişim sorunları");
  assert.equal(result.route, "rag");
  const original = JSON.parse(calls[0][1].content!).evidence;
  assert.ok(original.some((c: any) => c.id === "mfa-device:1"));
  assert.deepEqual(
    JSON.parse(calls[1].find((m) => m.role === "tool")!.content!),
    [],
  );
  assert.equal(result.citations[0].id, "mfa-device:1");
  s.store.close();
});

test("packing skips an oversized section without cutting text or admitting its citation", async () => {
  const books: Runbook[] = [
    {
      id: "large",
      tenant: "demo",
      scope: "it",
      title: "MFA",
      revision: "1",
      steps: [],
      sections: [{ title: "MFA", text: "MFA ".repeat(2000) }],
    },
    {
      id: "small",
      tenant: "demo",
      scope: "it",
      title: "MFA",
      revision: "1",
      steps: [],
      sections: [{ title: "MFA", text: "MFA güvenli kurtarma. Kod paylaşma." }],
    },
  ];
  const k = new Knowledge(books);
  assert.deepEqual(
    k.pack(k.allowed(principal)).map((c) => c.id),
    ["small:1"],
  );
  assert.ok(Buffer.byteLength(k.context(k.allowed(principal))) <= 2600);
  let calls = 0;
  const s = fixture(
    {
      async complete() {
        calls++;
        return final("large:1");
      },
    },
    k,
  );
  assert.equal((await s.ask("MFA")).route, "handoff");
  assert.equal(calls, 1);
  s.store.close();
});

test("another tenant with the same source ID cannot change authorized BM25 scores", () => {
  const books = Knowledge.load().books;
  const before = new Knowledge(books)
    .search(principal, "MFA telefon Outlook")
    .map((c) => c.id);
  const collision = {
    ...structuredClone(books[2]),
    tenant: "private",
    sections: [{ title: "MFA", text: "unrelated ".repeat(1000) }],
  };
  assert.deepEqual(
    new Knowledge([...books, collision])
      .search(principal, "MFA telefon Outlook")
      .map((c) => c.id),
    before,
  );
});
