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
  cache(key: string, a: Answer) {
    this.db
      .prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)")
      .run(key, JSON.stringify(a), Date.now() + 15 * 60_000);
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
  close() {
    this.db.close();
  }
}
