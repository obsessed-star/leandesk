import test from "node:test";
import assert from "node:assert/strict";
import { GroqProvider, ProviderError } from "../src/provider.ts";
import { verifyTelegramRequest } from "eve/channels/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";

test("Groq adapter sends bounded request and extracts actual usage", async () => {
  let body: any;
  const fake: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({
      choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 128 },
      },
    });
  };
  const p = new GroqProvider("test-key", "test-model", fake);
  const r = await p.complete([{ role: "user", content: "test" }], 120, true);
  assert.equal(body.max_completion_tokens, 120);
  assert.equal(body.tools[0].function.name, "search_knowledge");
  assert.deepEqual(r.usage, {
    input: 200,
    output: 30,
    cachedInput: 128,
    calls: 1,
  });
});
test("429 causes cooldown, never automatic retries", async () => {
  let calls = 0;
  const p = new GroqProvider("test-key", "test-model", async () => {
    calls++;
    return new Response("", { status: 429, headers: { "retry-after": "30" } });
  });
  await assert.rejects(
    p.complete([], 120, false),
    (e: unknown) => e instanceof ProviderError && e.code === "rate_limited",
  );
  await assert.rejects(
    p.complete([], 120, false),
    (e: unknown) =>
      e instanceof ProviderError && e.code === "provider_cooldown",
  );
  assert.equal(calls, 1);
});
test("truncated response retains billed usage", async () => {
  const p = new GroqProvider("test-key", "test-model", async () =>
    Response.json({
      choices: [{ message: { content: "{" }, finish_reason: "length" }],
      usage: { prompt_tokens: 200, completion_tokens: 120 },
    }),
  );
  await assert.rejects(
    p.complete([], 120, false),
    (e: unknown) => e instanceof ProviderError && e.usage?.output === 120,
  );
});
test("oversized request is stopped before network access", async () => {
  let calls = 0;
  const p = new GroqProvider("test-key", "test-model", async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    p.complete([{ role: "user", content: "x".repeat(13000) }], 120, false),
  );
  assert.equal(calls, 0);
});
test("Telegram native verifier rejects missing or wrong secrets", async () => {
  for (const value of ["", "wrong"])
    await assert.rejects(
      verifyTelegramRequest(
        new Request("http://local", {
          method: "POST",
          headers: { "X-Telegram-Bot-Api-Secret-Token": value },
          body: "{}",
        }),
        { secretToken: "test-webhook-secret" },
      ),
    );
  assert.equal(
    await verifyTelegramRequest(
      new Request("http://local", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
        body: '{"update_id":1}',
      }),
      { secretToken: "test-webhook-secret" },
    ),
    '{"update_id":1}',
  );
});
test("WhatsApp adapter rejects unsigned webhooks and verifies setup challenge", async () => {
  const adapter = createWhatsAppAdapter({
    accessToken: "test-token",
    appSecret: "test-secret",
    phoneNumberId: "123",
    verifyToken: "test-verify",
  });
  const denied = await adapter.handleWebhook(
    new Request("http://local", { method: "POST", body: "{}" }),
  );
  assert.ok(denied.status >= 400);
  const accepted = await adapter.handleWebhook(
    new Request(
      "http://local?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345",
    ),
  );
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "12345");
});
