import test from "node:test";
import assert from "node:assert/strict";
import { Knowledge } from "../src/knowledge.ts";
import { Store } from "../src/store.ts";
import { SupportAgent, ownerKey } from "../src/agent.ts";
import { Runtime } from "../src/runtime.ts";
import { deliver } from "../src/delivery.ts";
import {
  redact,
  zeroUsage,
  type Completion,
  type ModelMessage,
  type Provider,
  type RequestInput,
} from "../src/contracts.ts";
import { ProviderError } from "../src/provider.ts";

const principal = { id: "alice", tenant: "demo", scopes: ["it"] };
const question = "Yeni telefon aldım MFA uygulamasına erişemiyorum";
const result = (id = "mfa-device:1"): Completion => ({
  content: JSON.stringify({
    answer:
      "Onaylı kurtarma yöntemin var mı? Yoksa IT ekibine başvur; parola veya MFA kodu paylaşma.",
    citationIds: [id],
  }),
  toolCalls: [],
  usage: { input: 320, output: 45, cachedInput: 0, calls: 1 },
});
class Fake implements Provider {
  calls: ModelMessage[][] = [];
  constructor(readonly replies: (Completion | Error)[] = [result()]) {}
  async complete(messages: ModelMessage[]) {
    this.calls.push(structuredClone(messages));
    const next = this.replies.shift() ?? result();
    if (next instanceof Error) throw next;
    return next;
  }
}
function setup(
  provider?: Provider,
  knowledge = Knowledge.load(),
  budget?: ConstructorParameters<typeof SupportAgent>[3],
) {
  const store = new Store(":memory:");
  const agent = new SupportAgent(store, knowledge, provider, budget);
  let id = 0;
  const ask = (message = question, overrides: Partial<RequestInput> = {}) =>
    agent.handle({
      principal,
      channel: "api",
      conversation: "case",
      eventId: String(++id),
      message,
      ...overrides,
    });
  return { store, agent, ask };
}
test("approved error code uses a sourced runbook and no model", async () => {
  const fake = new Fake(),
    s = setup(fake);
  const a = await s.ask("Windows VPN 809 hatası");
  assert.equal(a.route, "runbook");
  assert.equal(a.usage.calls, 0);
  assert.equal(fake.calls.length, 0);
  assert.equal(a.citations[0].id, "vpn-809:1");
  s.store.close();
});
test("unknown subject asks for facts without a model call", async () => {
  const fake = new Fake(),
    s = setup(fake);
  assert.equal((await s.ask("zorbax quux")).route, "clarify");
  assert.equal(fake.calls.length, 0);
  s.store.close();
});
test("RAG returns only authorized source ids and reports provider usage", async () => {
  const fake = new Fake(),
    s = setup(fake),
    a = await s.ask();
  assert.equal(a.route, "rag");
  assert.equal(a.usage.input, 320);
  assert.equal(a.usage.output, 45);
  assert.equal(a.citations[0].id, "mfa-device:1");
  assert.ok(!JSON.stringify(fake.calls).includes("OTHER_TENANT_PRIVATE"));
  s.store.close();
});
test("same case and question reuses answer cache without another call", async () => {
  const fake = new Fake(),
    s = setup(fake);
  await s.ask();
  const a = await s.ask();
  assert.equal(a.route, "cache");
  assert.equal(a.usage.calls, 0);
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("document digest invalidates old cached answers", async () => {
  const fake = new Fake(),
    s = setup(fake);
  await s.ask();
  const books = structuredClone(Knowledge.load().books);
  books[2].revision = "new";
  const agent = new SupportAgent(s.store, new Knowledge(books), fake);
  const a = await agent.handle({
    principal,
    channel: "api",
    conversation: "case",
    eventId: "new-docs",
    message: question,
  });
  assert.equal(a.route, "rag");
  assert.equal(fake.calls.length, 2);
  s.store.close();
});
test("search filters tenant and role before scoring", () => {
  const k = Knowledge.load();
  assert.ok(
    k.allowed(principal).every((c) => c.tenant === "demo" && c.scope === "it"),
  );
  assert.ok(!k.search(principal, "OTHER_TENANT_PRIVATE").length);
  assert.ok(!k.allowed(principal).some((c) => c.id === "git-ssh:1"));
  assert.ok(
    k
      .allowed({ ...principal, scopes: ["engineering"] })
      .some((c) => c.id === "git-ssh:1"),
  );
});
test("context packing respects byte limit", () => {
  const k = Knowledge.load();
  assert.ok(Buffer.byteLength(k.context(k.allowed(principal), 400)) <= 400);
});
test("fabricated citations trigger handoff without regeneration", async () => {
  const fake = new Fake([result("nonexistent:1")]),
    s = setup(fake),
    a = await s.ask();
  assert.equal(a.route, "handoff");
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("malformed output is not cached or repaired with another call", async () => {
  const fake = new Fake([{ ...result(), content: "not json" }]),
    s = setup(fake);
  const a = await s.ask();
  assert.equal(a.route, "handoff");
  assert.equal(a.usage.calls, 1);
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
const searchReply = (
  name = "search_knowledge",
  args = '{"query":"MFA telefon kurtarma"}',
): Completion => ({
  content: null,
  toolCalls: [
    { id: "call_1", type: "function", function: { name, arguments: args } },
  ],
  usage: { input: 300, output: 30, cachedInput: 0, calls: 1 },
});
test("one retrieval tool call can be followed by one final answer", async () => {
  const fake = new Fake([searchReply(), result()]),
    s = setup(fake),
    a = await s.ask("MFA Outlook erişim sorunları");
  assert.equal(a.route, "rag");
  assert.equal(a.usage.calls, 2);
  assert.ok(fake.calls[1].some((m) => m.role === "tool"));
  s.store.close();
});
test("unknown tool names cannot execute", async () => {
  const fake = new Fake([searchReply("run_shell")]),
    s = setup(fake);
  assert.equal((await s.ask()).route, "handoff");
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("tool cannot inject a tenant or arbitrary argument", async () => {
  const fake = new Fake([
      searchReply(
        "search_knowledge",
        '{"query":"MFA","tenant":"other-company"}',
      ),
    ]),
    s = setup(fake);
  assert.equal((await s.ask()).route, "handoff");
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("agent never makes a third model call", async () => {
  const fake = new Fake([searchReply(), searchReply()]),
    s = setup(fake);
  assert.equal((await s.ask("MFA Outlook erişim sorunları")).route, "handoff");
  assert.equal(fake.calls.length, 2);
  s.store.close();
});
test("input budget is checked before spending", async () => {
  const fake = new Fake(),
    s = setup(fake, Knowledge.load(), {
      maxCalls: 2,
      maxInputBytes: 100,
      maxOutput: 384,
      maxSessionTokens: 18_000,
    });
  assert.equal((await s.ask()).route, "handoff");
  assert.equal(fake.calls.length, 0);
  s.store.close();
});
test("daily calls cannot be bypassed by starting another conversation", async () => {
  const fake = new Fake(),
    s = setup(fake);
  s.store.metric(ownerKey(principal), {
    text: "",
    route: "rag",
    citations: [],
    usage: { input: 1, output: 1, cachedInput: 0, calls: 40 },
  });
  assert.equal(
    (await s.ask(question, { conversation: "another-case" })).route,
    "handoff",
  );
  assert.equal(fake.calls.length, 0);
  s.store.close();
});
test("unreported usage stops further spending in the case", async () => {
  const fake = new Fake([
      new ProviderError("provider_unavailable", 0, {
        input: 0,
        output: 0,
        cachedInput: 0,
        calls: 1,
        unreportedCalls: 1,
      }),
    ]),
    s = setup(fake);
  assert.equal((await s.ask()).usage.unreportedCalls, 1);
  await s.ask("MFA hala çalışmıyor");
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("replayed event returns same answer with zero additional usage", async () => {
  const fake = new Fake(),
    s = setup(fake);
  const a = await s.ask(question, { eventId: "same" }),
    b = await s.ask(question, { eventId: "same" });
  assert.equal(a.text, b.text);
  assert.equal(b.replayed, true);
  assert.equal(b.usage.calls, 0);
  assert.equal(fake.calls.length, 1);
  s.store.close();
});
test("concurrent duplicates spend once", async () => {
  const fake = new Fake(),
    s = setup(fake);
  const results = await Promise.all([
    s.ask(question, { eventId: "same" }),
    s.ask(question, { eventId: "same" }),
  ]);
  assert.equal(fake.calls.length, 1);
  assert.equal(results.filter((a) => a.replayed).length, 1);
  s.store.close();
});
test("ticket stays a draft until its owner confirms explicitly", async () => {
  const s = setup();
  await s.ask("Windows VPN 809 hatası");
  const draft = await s.ask("/ticket");
  assert.equal(
    s.store.ticket(ownerKey(principal), draft.ticketId!)?.status,
    "draft",
  );
  await s.ask("/confirm " + draft.ticketId, {
    principal: { ...principal, id: "bob" },
  });
  assert.equal(
    s.store.ticket(ownerKey(principal), draft.ticketId!)?.status,
    "draft",
  );
  await s.ask("/confirm " + draft.ticketId);
  assert.equal(
    s.store.ticket(ownerKey(principal), draft.ticketId!)?.status,
    "queued",
  );
  s.store.close();
});
test("expired drafts cannot be submitted", async () => {
  const s = setup();
  await s.ask("Windows VPN 809 hatası");
  const draft = await s.ask("/ticket");
  s.store.db.prepare("UPDATE tickets SET created=0").run();
  await s.ask("/confirm " + draft.ticketId);
  assert.equal(
    s.store.ticket(ownerKey(principal), draft.ticketId!)?.status,
    "draft",
  );
  s.store.close();
});
test("ticket command with no issue asks for issue details", async () => {
  const s = setup();
  assert.equal((await s.ask("/ticket")).route, "clarify");
  s.store.close();
});
test("redaction covers email and common credential formats", () => {
  const text = redact("a@example.com gsk_test_123 parola=hunter2");
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("gsk_"));
  assert.ok(!text.includes("@"));
});
test("expired case facts are not sent to the provider", async () => {
  const fake = new Fake(),
    s = setup(fake);
  s.store.setSession(ownerKey(principal) + ":case", {
    issue: "OLD_SECRET_CASE",
    attempts: [],
    usage: zeroUsage(),
    updated: 0,
  });
  await s.ask();
  assert.ok(!JSON.stringify(fake.calls).includes("OLD_SECRET_CASE"));
  s.store.close();
});
test("HTTP authorization is server-side and ignores claimed tenants", async () => {
  const s = setup(),
    runtime = new Runtime(s.agent, [
      { ...principal, channel: "api", subject: "test-token" },
    ]);
  const unauth = await runtime.http(new Request("http://local/api/metrics"));
  assert.equal(unauth.status, 401);
  const res = await runtime.http(
    new Request("http://local/api/messages", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({
        message: question,
        conversation: "case",
        eventId: "1",
        tenant: "other-company",
      }),
    }),
  );
  assert.equal(res.status, 400);
  s.store.close();
});
test("HTTP rejects oversized and malformed bodies", async () => {
  const s = setup(),
    runtime = new Runtime(s.agent, [
      { ...principal, channel: "api", subject: "test-token" },
    ]);
  for (const [body, status] of [
    ["{bad", 400],
    ["x".repeat(12_001), 413],
  ] as const) {
    const r = await runtime.http(
      new Request("http://local/api/messages", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body,
      }),
    );
    assert.equal(r.status, status);
  }
  s.store.close();
});
test("unknown channel identities never invoke the agent or post", async () => {
  const s = setup(new Fake()),
    runtime = new Runtime(s.agent, []);
  let posts = 0;
  assert.equal(
    await deliver(
      runtime,
      "telegram",
      "unknown",
      "chat",
      "id",
      question,
      async () => {
        posts++;
      },
    ),
    false,
  );
  assert.equal(posts, 0);
  s.store.close();
});
test("delivery retries reuse persisted answer after a failed send", async () => {
  const fake = new Fake(),
    s = setup(fake),
    runtime = new Runtime(s.agent, [
      { ...principal, channel: "telegram", subject: "42" },
    ]);
  await assert.rejects(
    deliver(runtime, "telegram", "42", "chat", "id", question, async () => {
      throw Error("network");
    }),
  );
  let posts = 0;
  await deliver(runtime, "telegram", "42", "chat", "id", question, async () => {
    posts++;
  });
  await deliver(runtime, "telegram", "42", "chat", "id", question, async () => {
    posts++;
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(posts, 1);
  s.store.close();
});
test("concurrent transport retries do not post twice", async () => {
  const s = setup(new Fake()),
    runtime = new Runtime(s.agent, [
      { ...principal, channel: "telegram", subject: "42" },
    ]);
  let posts = 0;
  const send = () =>
    deliver(runtime, "telegram", "42", "chat", "id", question, async () => {
      posts++;
    });
  await Promise.all([send(), send()]);
  assert.equal(posts, 1);
  s.store.close();
});
test("explicit identity mapping shares a case across Telegram and WhatsApp", async () => {
  const s = setup(),
    runtime = new Runtime(s.agent, [
      { ...principal, channel: "telegram", subject: "42" },
      { ...principal, channel: "whatsapp", subject: "15550000000" },
    ]);
  await deliver(
    runtime,
    "telegram",
    "42",
    "tg",
    "1",
    "Windows VPN 809 hatası",
    async () => {},
  );
  let posted = "";
  await deliver(
    runtime,
    "whatsapp",
    "15550000000",
    "wa",
    "2",
    "/ticket",
    async (text) => {
      posted = text;
    },
  );
  assert.match(posted, /Windows VPN 809/);
  s.store.close();
});
