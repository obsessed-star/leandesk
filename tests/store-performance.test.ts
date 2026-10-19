import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { Answer } from "../src/contracts.ts";
const sample = (calls: number): Answer => ({
  text: "",
  route: "rag",
  citations: [],
  usage: { input: 1, output: 1, cachedInput: 0, calls },
});

test("indexed budget count matches usage JSON, including unknown usage calls", () => {
  const store = new Store(":memory:");
  try {
    store.metric("alice", sample(2));
    store.metric("alice", sample(0));
    store.metric("alice", {
      ...sample(1),
      usage: { ...sample(1).usage, unreportedCalls: 1 },
    });
    store.metric("bob", sample(37));
    assert.equal(store.recentCalls("alice"), 3);
    assert.equal(store.recentCalls("bob"), 37);
    assert.equal(store.recentCalls("absent"), 0);
    const legacy = store.db
      .prepare("SELECT usage FROM metrics WHERE owner=?")
      .all("alice")
      .reduce((n, r) => n + JSON.parse(String(r.usage)).calls, 0);
    assert.equal(store.recentCalls("alice"), legacy);
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(calls),0) FROM metrics WHERE owner=? AND created>? AND calls>0",
      )
      .all("alice", 0);
    assert.ok(
      plan.some((r) =>
        String(r.detail).includes("metrics_owner_positive_calls"),
      ),
    );
  } finally {
    store.close();
  }
});
test("rolling daily budget retains the exact open lower time boundary", () => {
  const store = new Store(":memory:"),
    now = 2_000_000_000_000,
    since = now - 86400_000;
  try {
    const insert = store.db.prepare(
      "INSERT INTO metrics(id,owner,route,usage,created,calls) VALUES(?,?,?,?,?,?)",
    );
    for (const [id, created, calls] of [
      ["old", since - 1, 8],
      ["boundary", since, 16],
      ["inside", since + 1, 2],
      ["now", now, 1],
    ] as const)
      insert.run(
        id,
        "alice",
        "rag",
        JSON.stringify(sample(calls).usage),
        created,
        calls,
      );
    assert.equal(store.recentCalls("alice", now), 3);
    assert.equal(store.recentCalls("alice", now + 1), 1);
  } finally {
    store.close();
  }
});
test("legacy databases backfill counters once without changing recorded usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "leandesk-migration-")),
    file = join(dir, "legacy.sqlite");
  let store: Store | undefined;
  try {
    const old = new DatabaseSync(file);
    old.exec(
      "CREATE TABLE metrics(id TEXT PRIMARY KEY,owner TEXT NOT NULL,route TEXT NOT NULL,usage TEXT NOT NULL,created INTEGER NOT NULL)",
    );
    const usage = JSON.stringify(sample(4).usage);
    old
      .prepare("INSERT INTO metrics VALUES(?,?,?,?,?)")
      .run("old", "alice", "rag", usage, Date.now());
    old.close();
    store = new Store(file);
    assert.equal(store.recentCalls("alice"), 4);
    assert.equal(store.metrics("alice")[0].usage.calls, 4);
    store.close();
    store = new Store(file);
    assert.equal(store.recentCalls("alice"), 4);
    store.metric("alice", sample(1));
    assert.equal(store.recentCalls("alice"), 5);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("invalid counters cannot weaken the daily limit or write partial metrics", () => {
  const store = new Store(":memory:");
  try {
    for (const calls of [-1, 1.5, NaN])
      assert.throws(
        () => store.metric("alice", sample(calls)),
        /invalid_call_count/,
      );
    assert.equal(store.metrics("alice").length, 0);
  } finally {
    store.close();
  }
});
