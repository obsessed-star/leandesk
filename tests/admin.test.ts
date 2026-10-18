import test from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import { SupportAgent, ownerKey } from "../src/agent.ts";
import { Knowledge } from "../src/knowledge.ts";
import type { Provider } from "../src/contracts.ts";

const origin = "http://localhost",
  token = "admin-test-token-at-least-thirty-two-chars";
const alice = {
  channel: "api" as const,
  subject: "support-alice",
  id: "alice",
  tenant: "demo",
  scopes: ["it"],
};
const bob = {
  ...alice,
  subject: "support-bob",
  id: "bob",
  tenant: "other-company",
};
function setup(provider?: Provider) {
  const store = new Store(":memory:");
  const runtime = new Runtime(
    new SupportAgent(store, Knowledge.load(), provider),
    [alice, bob],
    [{ id: "ops", tenant: "demo", token }],
  );
  const call = (
    path: string,
    body?: unknown,
    cookie = "",
    csrf = "",
    requestOrigin = origin,
  ) =>
    runtime.http(
      new Request(origin + "/admin" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: requestOrigin,
          cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const login = async () => {
    const response = await call("/api/login", { token });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      csrf: (await response.json()).csrf as string,
    };
  };
  return { store, runtime, call, login };
}

test("admin shell is public but has CSP and exposes no secrets or private data", async () => {
  const s = setup();
  try {
    const response = await s.call("");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /Yönetici anahtarı/);
    assert.ok(!html.includes(token));
    assert.ok(!html.includes(alice.subject));
    for (const path of ["/api/session", "/api/overview", "/api/knowledge"])
      assert.equal((await s.call(path)).status, 401);
  } finally {
    s.store.close();
  }
});

test("admin login cannot reuse a support bearer token and throttles failed attempts", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await s.call("/api/login", { token: alice.subject })).status,
        401,
      );
    assert.equal((await s.call("/api/login", { token })).status, 429);
  } finally {
    s.store.close();
  }
});

test("admin mutations require same origin, session and CSRF; logout revokes cookie", async () => {
  const s = setup();
  try {
    assert.equal(
      (await s.call("/api/login", { token }, "", "", "https://evil.example"))
        .status,
      403,
    );
    const auth = await s.login();
    const session = await s.call("/api/session", undefined, auth.cookie);
    assert.equal(session.status, 200);
    assert.equal(
      (await s.call("/api/pause", { paused: true }, auth.cookie)).status,
      403,
    );
    assert.equal(
      (
        await s.call(
          "/api/pause",
          { paused: true },
          auth.cookie,
          auth.csrf,
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(s.store.paused("demo"), false);
    const response = await s.call("/api/logout", {}, auth.cookie, auth.csrf);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("set-cookie")!,
      /HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=0/,
    );
    assert.equal(
      (await s.call("/api/overview", undefined, auth.cookie)).status,
      401,
    );
  } finally {
    s.store.close();
  }
});

test("overview metrics, tickets and cache mutations stay inside the administrator tenant", async () => {
  const s = setup();
  try {
    const own = ownerKey(alice),
      other = ownerKey(bob),
      answer = {
        text: "sample",
        route: "rag" as const,
        citations: [],
        usage: { input: 12, output: 8, cachedInput: 0, calls: 1 },
      };
    s.store.metric(own, answer);
    s.store.metric(other, {
      ...answer,
      usage: { ...answer.usage, input: 999999 },
    });
    s.store.cache("own", answer, own);
    s.store.cache("other", answer, other);
    s.store.cache("legacy", answer);
    s.store.draft(other, "PRIVATE_OTHER_COMPANY");
    const auth = await s.login();
    const data = await (
      await s.call("/api/overview", undefined, auth.cookie)
    ).json();
    assert.equal(data.summary.inputTokens, 12);
    assert.equal(data.summary.calls, 1);
    assert.equal(data.cacheEntries, 1);
    assert.ok(!JSON.stringify(data).includes("PRIVATE_OTHER_COMPANY"));
    assert.ok(!JSON.stringify(data).includes(alice.subject));
    assert.ok(!JSON.stringify(data).includes(token));
    const cleared = await (
      await s.call("/api/cache/clear", {}, auth.cookie, auth.csrf)
    ).json();
    assert.equal(cleared.cleared, 1);
    assert.equal(s.store.cached("own"), undefined);
    assert.ok(s.store.cached("other"));
    assert.ok(s.store.cached("legacy"));
    assert.equal(
      s.store.adminData("demo", [own]).audit[0].action,
      "cache.clear",
    );
  } finally {
    s.store.close();
  }
});

test("model pause is tenant scoped, preserves local runbooks and resumes without a retry loop", async () => {
  let calls = 0;
  const provider: Provider = {
    async complete() {
      calls++;
      return {
        content: JSON.stringify({
          answer: "Kurtarma yöntemini kontrol et.",
          citationIds: ["mfa-device:1"],
        }),
        toolCalls: [],
        usage: { input: 10, output: 5, cachedInput: 0, calls: 1 },
      };
    },
  };
  const s = setup(provider);
  try {
    const auth = await s.login();
    await s.call("/api/pause", { paused: true }, auth.cookie, auth.csrf);
    assert.equal(s.store.paused("demo"), true);
    assert.equal(s.store.paused("other-company"), false);
    const request = {
      principal: alice,
      channel: "api" as const,
      conversation: "mfa",
      eventId: "1",
      message: "Yeni telefon MFA uygulaması çalışmıyor",
    };
    assert.equal((await s.runtime.agent.handle(request)).route, "handoff");
    assert.equal(calls, 0);
    assert.equal(
      (
        await s.runtime.agent.handle({
          ...request,
          conversation: "vpn",
          eventId: "2",
          message: "Windows VPN 809 hatası",
        })
      ).route,
      "runbook",
    );
    await s.call("/api/pause", { paused: false }, auth.cookie, auth.csrf);
    assert.equal(
      (await s.runtime.agent.handle({ ...request, eventId: "3" })).route,
      "rag",
    );
    assert.equal(calls, 1);
  } finally {
    s.store.close();
  }
});

test("pause arriving during the first model call blocks a second tool completion", async () => {
  let calls = 0;
  const s = setup({
    async complete() {
      calls++;
      s.store.setPaused("demo", "ops", true);
      return {
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
        usage: { input: 10, output: 3, cachedInput: 0, calls: 1 },
      };
    },
  });
  try {
    const result = await s.runtime.agent.handle({
      principal: alice,
      channel: "api",
      conversation: "tool",
      eventId: "one",
      message: "MFA Outlook erişim sorunları",
    });
    assert.equal(result.route, "handoff");
    assert.equal(result.usage.input, 10);
    assert.equal(calls, 1);
  } finally {
    s.store.close();
  }
});

test("admin cannot approve a user draft or mutate another tenant ticket", async () => {
  const s = setup();
  try {
    const owner = ownerKey(alice),
      draft = s.store.draft(owner, "draft"),
      queued = s.store.draft(owner, "queued"),
      other = s.store.draft(ownerKey(bob), "private");
    s.store.confirm(owner, queued);
    const auth = await s.login();
    for (const id of [draft, other])
      assert.equal(
        (
          await s.call(
            "/api/ticket",
            { id, status: "resolved" },
            auth.cookie,
            auth.csrf,
          )
        ).status,
        404,
      );
    assert.equal(
      (
        await s.call(
          "/api/ticket",
          { id: queued, status: "resolved" },
          auth.cookie,
          auth.csrf,
        )
      ).status,
      200,
    );
    assert.equal(s.store.ticket(owner, queued)?.status, "resolved");
    assert.equal(
      (
        await s.call(
          "/api/ticket",
          { id: queued, status: "queued" },
          auth.cookie,
          auth.csrf,
        )
      ).status,
      200,
    );
    assert.equal(s.store.ticket(owner, queued)?.status, "queued");
    assert.equal(s.store.ticket(owner, draft)?.status, "draft");
  } finally {
    s.store.close();
  }
});

test("admin source search spends no model tokens and never returns another tenant source", async () => {
  let calls = 0;
  const s = setup({
    async complete() {
      calls++;
      throw Error("must not call");
    },
  });
  try {
    const auth = await s.login();
    const response = await (
      await s.call(
        "/api/search",
        { query: "Yeni telefon MFA kurtarma" },
        auth.cookie,
        auth.csrf,
      )
    ).json();
    assert.equal(response.modelCalls, 0);
    assert.equal(response.results[0].id, "mfa-device:1");
    const blocked = await (
      await s.call(
        "/api/search",
        { query: "OTHER_TENANT_PRIVATE" },
        auth.cookie,
        auth.csrf,
      )
    ).json();
    assert.deepEqual(blocked.results, []);
    assert.equal(calls, 0);
    assert.equal(
      (
        await s.call(
          "/api/search",
          { query: "MFA", tenant: "other-company" },
          auth.cookie,
          auth.csrf,
        )
      ).status,
      400,
    );
  } finally {
    s.store.close();
  }
});

test("admin mutation and its audit record commit atomically", async () => {
  const s = setup();
  try {
    s.store.db.exec(
      "CREATE TRIGGER block_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    assert.throws(() => s.store.setPaused("demo", "ops", true));
    assert.equal(s.store.paused("demo"), false);
  } finally {
    s.store.close();
  }
});
