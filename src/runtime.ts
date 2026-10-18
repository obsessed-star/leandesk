import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SupportAgent, eventKey, ownerKey } from "./agent.ts";
import { GroqProvider } from "./provider.ts";
import { Knowledge } from "./knowledge.ts";
import { Store } from "./store.ts";
import type { Channel, Principal } from "./contracts.ts";
import {
  AdminConsole,
  adminIdentitySchema,
  type AdminIdentity,
} from "./admin.ts";

const principal = z
  .object({
    id: z.string().min(1),
    tenant: z.string().min(1),
    scopes: z.array(z.string()).min(1),
  })
  .strict();
const identities = z.array(
  principal.extend({
    channel: z.enum(["api", "telegram", "whatsapp"]),
    subject: z.string().min(1),
  }),
);
export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class Runtime {
  readonly admin: AdminConsole;
  constructor(
    readonly agent: SupportAgent,
    readonly bindings: z.infer<typeof identities>,
    admins: AdminIdentity[] = [],
  ) {
    this.admin = new AdminConsole(this, admins);
  }
  identify(channel: Channel, subject: string): Principal | undefined {
    const found = this.bindings.find(
      (p) =>
        p.channel === channel &&
        (channel === "api"
          ? equalSecret(p.subject, subject)
          : p.subject === subject),
    );
    return found
      ? { id: found.id, tenant: found.tenant, scopes: found.scopes }
      : undefined;
  }
  async http(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      return this.admin.http(request);
    if (request.method === "GET" && url.pathname === "/healthz")
      return Response.json({
        status: "ok",
        service: "leandesk",
        searchBackend: this.agent.knowledge.backend,
        groqConfigured: !!process.env.GROQ_API_KEY,
      });
    const p = this.identify(
      "api",
      request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    );
    if (!p) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/api/metrics" && request.method === "GET")
      return Response.json({ metrics: this.agent.store.metrics(ownerKey(p)) });
    if (url.pathname !== "/api/messages" || request.method !== "POST")
      return Response.json({ error: "not_found" }, { status: 404 });
    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    if (Buffer.byteLength(raw) > 12_000)
      return Response.json({ error: "body_too_large" }, { status: 413 });
    const schema = z
      .object({
        message: z.string().min(1).max(2000),
        conversation: z.string().min(1).max(160),
        eventId: z.string().min(1).max(160),
      })
      .strict();
    try {
      const input = schema.parse(JSON.parse(raw));
      return Response.json(
        await this.agent.handle({ ...input, principal: p, channel: "api" }),
      );
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
  }
}
let singleton: Runtime | undefined;
export function getRuntime(): Runtime {
  if (!singleton) {
    const bindings = identities.parse(
      JSON.parse(process.env.SUPPORT_IDENTITIES_JSON ?? "[]"),
    );
    singleton = new Runtime(
      new SupportAgent(
        new Store(process.env.SUPPORT_DB_PATH),
        Knowledge.load(process.env.SUPPORT_KNOWLEDGE_PATH),
        process.env.GROQ_API_KEY
          ? new GroqProvider(process.env.GROQ_API_KEY)
          : undefined,
      ),
      bindings,
      adminIdentitySchema.parse(
        JSON.parse(process.env.SUPPORT_ADMIN_IDENTITIES_JSON ?? "[]"),
      ),
    );
  }
  return singleton;
}
export { eventKey };
