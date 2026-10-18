import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ownerKey } from "./agent.ts";
import type { Runtime } from "./runtime.ts";

export const adminIdentitySchema = z
  .array(
    z
      .object({
        token: z.string().min(32).max(512),
        id: z.string().min(1).max(100),
        tenant: z.string().min(1).max(100),
      })
      .strict(),
  )
  .max(100);
export type AdminIdentity = z.infer<typeof adminIdentitySchema>[number];
interface Session {
  id: string;
  tenant: string;
  csrf: string;
  expires: number;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const security = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/** Tenant-scoped administration, deliberately separate from support bearer tokens. */
export class AdminConsole {
  private readonly sessions = new Map<string, Session>();
  private failures: number[] = [];
  constructor(
    private runtime: Runtime,
    private identities: AdminIdentity[],
  ) {}
  private json(
    value: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) {
    return Response.json(value, {
      status,
      headers: { ...security, ...headers },
    });
  }
  private cookie(request: Request, value: string, age: number) {
    const secure =
      new URL(request.url).protocol === "https:" ||
      process.env.SUPPORT_ADMIN_SECURE_COOKIE === "true";
    return `ld_admin=${value}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${age}${secure ? "; Secure" : ""}`;
  }
  private session(request: Request): Session | undefined {
    const token = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ld_admin="))
      ?.slice(9);
    if (!token) return;
    const key = hash(token),
      value = this.sessions.get(key);
    if (value && value.expires > Date.now()) return value;
    this.sessions.delete(key);
  }
  private owners(session: Session) {
    return new Map(
      this.runtime.bindings
        .filter((p) => p.tenant === session.tenant)
        .map((p) => [ownerKey(p), p.id]),
    );
  }
  private async body(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw Error("invalid_body");
    const text = await request.text();
    if (Buffer.byteLength(text) > 4096) throw Error("invalid_body");
    return JSON.parse(text);
  }
  async http(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const assets: Record<string, [string, string]> = {
      "/admin": ["index.html", "text/html; charset=utf-8"],
      "/admin/": ["index.html", "text/html; charset=utf-8"],
      "/admin/assets/app": ["app.js", "text/javascript; charset=utf-8"],
      "/admin/assets/styles": ["styles.css", "text/css; charset=utf-8"],
    };
    if (request.method === "GET" && assets[path]) {
      const [file, type] = assets[path];
      return new Response(readFileSync(resolve("admin", file), "utf8"), {
        headers: { ...security, "Content-Type": type },
      });
    }
    if (request.method === "POST") {
      const expected =
        process.env.SUPPORT_ADMIN_ORIGIN ?? new URL(request.url).origin;
      if (request.headers.get("origin") !== expected)
        return this.json({ error: "invalid_origin" }, 403);
    }
    if (path === "/admin/api/login" && request.method === "POST") {
      this.failures = this.failures.filter(
        (time) => time > Date.now() - 60_000,
      );
      if (this.failures.length >= 10)
        return this.json({ error: "try_later" }, 429, { "Retry-After": "60" });
      let token: string;
      try {
        token = z
          .object({ token: z.string().min(1).max(512) })
          .strict()
          .parse(await this.body(request)).token;
      } catch {
        this.failures.push(Date.now());
        return this.json({ error: "invalid_credentials" }, 401);
      }
      const identity = this.identities.find((p) => same(p.token, token));
      if (!identity) {
        this.failures.push(Date.now());
        return this.json({ error: "invalid_credentials" }, 401);
      }
      const now = Date.now();
      for (const [key, value] of this.sessions)
        if (value.expires <= now) this.sessions.delete(key);
      if (this.sessions.size >= 256)
        this.sessions.delete(this.sessions.keys().next().value!);
      const raw = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      const session = {
        id: identity.id,
        tenant: identity.tenant,
        csrf,
        expires: now + 8 * 60 * 60_000,
      };
      this.sessions.set(hash(raw), session);
      this.runtime.agent.store.audit(
        session.tenant,
        session.id,
        "session.login",
      );
      return this.json(
        { user: { id: session.id, tenant: session.tenant }, csrf },
        200,
        { "Set-Cookie": this.cookie(request, raw, 8 * 60 * 60) },
      );
    }
    const session = this.session(request);
    if (!session) return this.json({ error: "unauthorized" }, 401);
    if (
      request.method === "POST" &&
      !same(request.headers.get("x-csrf-token") ?? "", session.csrf)
    )
      return this.json({ error: "invalid_csrf" }, 403);
    const store = this.runtime.agent.store,
      owners = this.owners(session);
    if (path === "/admin/api/session" && request.method === "GET")
      return this.json({
        user: { id: session.id, tenant: session.tenant },
        csrf: session.csrf,
      });
    if (path === "/admin/api/logout" && request.method === "POST") {
      for (const [key, value] of this.sessions)
        if (value === session) this.sessions.delete(key);
      store.audit(session.tenant, session.id, "session.logout");
      return this.json({ ok: true }, 200, {
        "Set-Cookie": this.cookie(request, "", 0),
      });
    }
    if (path === "/admin/api/overview" && request.method === "GET") {
      const data = store.adminData(session.tenant, [...owners.keys()]);
      return this.json({
        ...data,
        tickets: data.tickets.map(({ owner, ...ticket }) => ({
          ...ticket,
          user: owners.get(String(owner)) ?? "Kullanıcı",
        })),
        tenant: session.tenant,
        users: owners.size,
        now: Date.now(),
        engine: {
          backend: this.runtime.agent.knowledge.backend,
          groqConfigured: !!process.env.GROQ_API_KEY,
          model: process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b",
        },
        channels: {
          telegram: !!(
            process.env.TELEGRAM_BOT_TOKEN &&
            process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
          ),
          whatsapp: !!(
            process.env.WHATSAPP_ACCESS_TOKEN &&
            process.env.WHATSAPP_APP_SECRET &&
            process.env.WHATSAPP_PHONE_NUMBER_ID &&
            process.env.WHATSAPP_VERIFY_TOKEN
          ),
        },
        limits: { ...this.runtime.agent.budget, dailyCallsPerOwner: 40 },
      });
    }
    if (path === "/admin/api/knowledge" && request.method === "GET")
      return this.json({
        books: this.runtime.agent.knowledge.books
          .filter((b) => b.tenant === session.tenant)
          .map((b) => ({
            id: b.id,
            title: b.title,
            scope: b.scope,
            revision: b.revision,
            sections: b.sections.length,
            fastPath: !!b.errorCode,
          })),
      });
    try {
      if (path === "/admin/api/search" && request.method === "POST") {
        const { query } = z
          .object({ query: z.string().trim().min(1).max(180) })
          .strict()
          .parse(await this.body(request));
        const knowledge = this.runtime.agent.knowledge;
        const scopes = [
          ...new Set(
            knowledge.books
              .filter((b) => b.tenant === session.tenant)
              .map((b) => b.scope),
          ),
        ];
        const start = performance.now(),
          results = knowledge.search(
            { id: session.id, tenant: session.tenant, scopes },
            query,
          );
        return this.json({
          results: results.map(({ tenant, scope, ...source }) => ({
            ...source,
            scope,
          })),
          durationMs: Number((performance.now() - start).toFixed(3)),
          backend: knowledge.backend,
          modelCalls: 0,
        });
      }
      if (path === "/admin/api/pause" && request.method === "POST") {
        const { paused } = z
          .object({ paused: z.boolean() })
          .strict()
          .parse(await this.body(request));
        store.setPaused(session.tenant, session.id, paused);
        return this.json({ paused });
      }
      if (path === "/admin/api/cache/clear" && request.method === "POST") {
        z.object({})
          .strict()
          .parse(await this.body(request));
        return this.json({
          cleared: store.clearOwnerCache(session.tenant, session.id, [
            ...owners.keys(),
          ]),
        });
      }
      if (path === "/admin/api/ticket" && request.method === "POST") {
        const { id, status } = z
          .object({
            id: z.string().uuid(),
            status: z.enum(["queued", "resolved"]),
          })
          .strict()
          .parse(await this.body(request));
        const ok = store.setTicketStatus(
          session.tenant,
          session.id,
          [...owners.keys()],
          id,
          status,
        );
        return this.json(
          ok ? { ok: true } : { error: "ticket_not_actionable" },
          ok ? 200 : 404,
        );
      }
    } catch {
      return this.json({ error: "invalid_request" }, 400);
    }
    return this.json({ error: "not_found" }, 404);
  }
}
