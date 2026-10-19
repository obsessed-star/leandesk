import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../src/store.ts";
const store = new Store(":memory:"),
  rows = 50000,
  now = Date.now();
try {
  store.db.exec("BEGIN");
  const insert = store.db.prepare(
    "INSERT INTO metrics(id,owner,route,usage,created,calls) VALUES(?,?,?,?,?,?)",
  );
  for (let i = 0; i < rows; i++) {
    const calls = i % 1250 === 0 ? 1 : 0;
    insert.run(
      String(i),
      i % 2 === 0 ? "alice" : "bob",
      calls ? "rag" : "cache",
      JSON.stringify({
        input: calls * 300,
        output: calls * 50,
        cachedInput: 0,
        calls,
      }),
      now - i,
      calls,
    );
  }
  store.db.exec("COMMIT");
  const before = () =>
    store.db
      .prepare("SELECT usage FROM metrics WHERE owner=? AND created>?")
      .all("alice", now - 86400_000)
      .reduce((n, r) => n + Number(JSON.parse(String(r.usage)).calls), 0);
  const after = () => store.recentCalls("alice", now);
  assert.equal(before(), 40);
  assert.equal(after(), 40);
  const measure = (fn: () => number) => {
    for (let i = 0; i < 5; i++) fn();
    const times = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      assert.equal(fn(), 40);
      times.push(performance.now() - start);
    }
    return Number(times.sort((a, b) => a - b)[7].toFixed(4));
  };
  const legacyMs = measure(before),
    indexedMs = measure(after);
  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    mode: "actual SQLite rolling call-budget comparison",
    scope:
      "50,000 synthetic metrics split across two owners; 40 billed calls and many zero-call local events. Same result, five warm-ups, median of 15 in-memory probes. Excludes migration, writes, Groq and end-to-end response time.",
    rows,
    expectedCalls: 40,
    legacyMs,
    indexedMs,
    speedup: Number((legacyMs / indexedMs).toFixed(2)),
  };
  mkdirSync("evidence", { recursive: true });
  writeFileSync(
    "evidence/budget-performance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
}
