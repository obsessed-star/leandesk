import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Knowledge } from "../src/knowledge.ts";
import type { SearchBackend } from "../src/rust-search.ts";
const principal = { id: "benchmark", tenant: "demo", scopes: ["it"] };
const samples = Knowledge.load().books.filter(
  (b) => b.tenant === "demo" && b.scope === "it",
);
const queries = [
  "MFA telefon kurtarma",
  "Outlook eşitleme",
  "Windows VPN 809",
  "yazıcı çevrimdışı",
  "unknown zorbax",
];
const rows = [];
for (const size of [800, 8000, 20000]) {
  const books = Array.from({ length: size }, (_, i) => ({
    ...samples[i % samples.length],
    id: `doc-${i}`,
    tenant: i % 5 === 0 ? "other-company" : "demo",
  }));
  const measure = (backend: SearchBackend) => {
    const start = performance.now(),
      k = new Knowledge(books, backend);
    const constructionMs = performance.now() - start;
    for (let i = 0; i < 15; i++)
      k.search(principal, queries[i % queries.length]);
    const times: number[] = [];
    // Compare amortized query cost; wall time includes the JS/WASM bridge,
    // authorization, tokenization and result mapping, not only Rust arithmetic.
    for (let round = 0; round < 15; round++) {
      const from = performance.now();
      for (const query of queries) k.search(principal, query);
      times.push((performance.now() - from) / queries.length);
    }
    times.sort((a, b) => a - b);
    return {
      backend: k.backend,
      constructionMs: Number(constructionMs.toFixed(3)),
      warmMedianMsPerQuery: Number(times[7].toFixed(4)),
      results: queries.map((q) => k.search(principal, q).map((c) => c.id)),
    };
  };
  const typescript = measure("typescript"),
    rust = measure("rust");
  assert.equal(rust.backend, "rust");
  assert.deepEqual(rust.results, typescript.results);
  rows.push({
    documents: size,
    typescript,
    rust,
    speedup: Number(
      (typescript.warmMedianMsPerQuery / rust.warmMedianMsPerQuery).toFixed(2),
    ),
  });
}
const report = {
  measuredAt: new Date().toISOString(),
  mode: "actual-rust-wasm-vs-typescript",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  scope:
    "Synthetic IT corpus, five queries, 15 warm-up queries, median of 15 five-query batches. Includes bridge and authorization. Construction reported separately. No Groq request, token or end-to-end response-time claim.",
  results: rows,
};
mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/rust-search.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
