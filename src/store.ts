import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Answer, Usage } from "./contracts.ts";

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ".data/leandesk.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events(key TEXT PRIMARY KEY,answer TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,answer TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(id TEXT PRIMARY KEY,owner TEXT NOT NULL,route TEXT NOT NULL,usage TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS links(channel TEXT NOT NULL,subject TEXT NOT NULL,principal TEXT NOT NULL,PRIMARY KEY(channel,subject));`);
    if (
      !this.db
        .prepare("PRAGMA table_info(cache)")
        .all()
        .some((c) => c.name === "owner")
    ) {
      this.db.exec(
        "ALTER TABLE cache ADD COLUMN owner TEXT NOT NULL DEFAULT ''",
      );
    }
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS metrics_owner_created ON metrics(owner,created);
      CREATE INDEX IF NOT EXISTS tickets_owner_created ON tickets(owner,created);
      CREATE INDEX IF NOT EXISTS cache_owner ON cache(owner);
      CREATE TABLE IF NOT EXISTS admin_settings(tenant TEXT PRIMARY KEY,paused INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_tenant_created ON admin_audit(tenant,created);`);
  }
  event(key: string): Answer | undefined {
    const r = this.db.prepare("SELECT answer FROM events WHERE key=?").get(key);
    return r ? JSON.parse(String(r.answer)) : undefined;
  }
  delivered(key: string): boolean {
    return (
      this.db.prepare("SELECT delivered FROM events WHERE key=?").get(key)
        ?.delivered === 1
    );
  }
  markDelivered(key: string) {
    this.db.prepare("UPDATE events SET delivered=1 WHERE key=?").run(key);
  }
  saveEvent(key: string, a: Answer) {
    this.db
      .prepare("INSERT INTO events(key,answer) VALUES(?,?)")
      .run(key, JSON.stringify(a));
  }
  session(
    key: string,
  ):
    | { issue: string; attempts: string[]; usage: Usage; updated: number }
    | undefined {
    const r = this.db
      .prepare("SELECT state FROM sessions WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.state)) : undefined;
  }
  setSession(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  cached(key: string, now = Date.now()): Answer | undefined {
    const r = this.db
      .prepare("SELECT answer FROM cache WHERE key=? AND expires>?")
      .get(key, now);
    return r ? JSON.parse(String(r.answer)) : undefined;
  }
  cache(key: string, a: Answer, owner = "") {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cache(key,answer,expires,owner) VALUES(?,?,?,?)",
      )
      .run(key, JSON.stringify(a), Date.now() + 15 * 60_000, owner);
  }
  draft(owner: string, body: string) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO tickets VALUES(?,?,?,?,?)")
      .run(id, owner, body, "draft", Date.now());
    return id;
  }
  ticket(owner: string, id: string) {
    return this.db
      .prepare("SELECT * FROM tickets WHERE owner=? AND id=?")
      .get(owner, id);
  }
  confirm(owner: string, id: string) {
    return (
      this.db
        .prepare(
          "UPDATE tickets SET status='queued' WHERE owner=? AND id=? AND status='draft' AND created>?",
        )
        .run(owner, id, Date.now() - 30 * 60_000).changes === 1
    );
  }
  metric(owner: string, a: Answer) {
    this.db
      .prepare("INSERT INTO metrics VALUES(?,?,?,?,?)")
      .run(randomUUID(), owner, a.route, JSON.stringify(a.usage), Date.now());
  }
  metrics(owner: string) {
    return this.db
      .prepare(
        "SELECT route,usage,created FROM metrics WHERE owner=? ORDER BY created",
      )
      .all(owner)
      .map((r) => ({ ...r, usage: JSON.parse(String(r.usage)) }));
  }
  recentCalls(owner: string) {
    return this.db
      .prepare("SELECT usage FROM metrics WHERE owner=? AND created>?")
      .all(owner, Date.now() - 24 * 60 * 60_000)
      .reduce((n, r) => n + Number(JSON.parse(String(r.usage)).calls), 0);
  }
  paused(tenant: string): boolean {
    return (
      this.db
        .prepare("SELECT paused FROM admin_settings WHERE tenant=?")
        .get(tenant)?.paused === 1
    );
  }
  audit(
    tenant: string,
    actor: string,
    action: string,
    detail: Record<string, unknown> = {},
  ) {
    this.db
      .prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        tenant,
        actor,
        action,
        JSON.stringify(detail),
        Date.now(),
      );
  }
  private adminTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  setPaused(tenant: string, actor: string, paused: boolean) {
    this.adminTransaction(() => {
      this.db
        .prepare(
          "INSERT INTO admin_settings(tenant,paused) VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET paused=excluded.paused",
        )
        .run(tenant, Number(paused));
      this.audit(tenant, actor, paused ? "model.pause" : "model.resume");
    });
  }
  clearOwnerCache(tenant: string, actor: string, owners: string[]): number {
    return this.adminTransaction(() => {
      const count = owners.length
        ? Number(
            this.db
              .prepare(
                `DELETE FROM cache WHERE owner IN (${owners.map(() => "?").join(",")})`,
              )
              .run(...owners).changes,
          )
        : 0;
      this.audit(tenant, actor, "cache.clear", { count });
      return count;
    });
  }
  setTicketStatus(
    tenant: string,
    actor: string,
    owners: string[],
    id: string,
    status: "queued" | "resolved",
  ): boolean {
    return this.adminTransaction(() => {
      const changed =
        owners.length &&
        Number(
          this.db
            .prepare(
              `UPDATE tickets SET status=? WHERE id=? AND owner IN (${owners.map(() => "?").join(",")}) AND status IN ('queued','resolved') AND status<>?`,
            )
            .run(status, id, ...owners, status).changes,
        );
      if (changed)
        this.audit(
          tenant,
          actor,
          status === "resolved" ? "ticket.resolve" : "ticket.reopen",
          { id },
        );
      return !!changed;
    });
  }
  adminData(tenant: string, owners: string[], now = Date.now()) {
    const filter = owners.length
      ? `owner IN (${owners.map(() => "?").join(",")})`
      : "0";
    const since = now - 24 * 60 * 60_000;
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) requests,
      COALESCE(SUM(json_extract(usage,'$.calls')),0) calls,
      COALESCE(SUM(json_extract(usage,'$.input')),0) inputTokens,
      COALESCE(SUM(json_extract(usage,'$.output')),0) outputTokens,
      COALESCE(SUM(json_extract(usage,'$.cachedInput')),0) cachedInputTokens,
      COALESCE(SUM(json_extract(usage,'$.unreportedCalls')),0) unreportedCalls
      FROM metrics WHERE ${filter} AND created>=?`,
      )
      .get(...owners, since)!;
    const routes = this.db
      .prepare(
        `SELECT route,COUNT(*) count FROM metrics WHERE ${filter} AND created>=? GROUP BY route ORDER BY count DESC`,
      )
      .all(...owners, since);
    const date = new Date(now),
      firstDay =
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
        6 * 86400_000;
    const daily = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d',created/1000,'unixepoch') day,COUNT(*) requests,COALESCE(SUM(json_extract(usage,'$.input')+json_extract(usage,'$.output')),0) tokens FROM metrics WHERE ${filter} AND created>=? GROUP BY day ORDER BY day`,
      )
      .all(...owners, firstDay);
    const tickets = this.db
      .prepare(
        `SELECT id,owner,body,status,created FROM tickets WHERE ${filter} ORDER BY created DESC LIMIT 50`,
      )
      .all(...owners);
    const ticketCounts = this.db
      .prepare(
        `SELECT status,COUNT(*) count FROM tickets WHERE ${filter} GROUP BY status`,
      )
      .all(...owners);
    const cacheEntries = Number(
      this.db
        .prepare(
          `SELECT COUNT(*) count FROM cache WHERE ${filter} AND expires>?`,
        )
        .get(...owners, now)?.count ?? 0,
    );
    const audit = this.db
      .prepare(
        "SELECT id,actor,action,detail,created FROM admin_audit WHERE tenant=? ORDER BY created DESC LIMIT 30",
      )
      .all(tenant)
      .map((r) => ({
        id: String(r.id),
        actor: String(r.actor),
        action: String(r.action),
        created: Number(r.created),
        detail: JSON.parse(String(r.detail)),
      }));
    return {
      summary,
      routes,
      daily,
      tickets,
      ticketCounts,
      cacheEntries,
      audit,
      paused: this.paused(tenant),
    };
  }
  close() {
    this.db.close();
  }
}
