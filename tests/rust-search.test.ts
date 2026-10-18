import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Knowledge } from "../src/knowledge.ts";
import type { Runbook } from "../src/contracts.ts";

const books = Knowledge.load().books;
test("missing WASM falls back in auto mode and fails closed in explicit Rust mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "leandesk-no-wasm-"));
  try {
    const code = `import {Knowledge} from ${JSON.stringify(new URL("../src/knowledge.ts", import.meta.url).href)};
      const books = Array.from({length: 64}, (_, i) => ({id:String(i), tenant:'demo', scope:'it', title:'MFA', revision:'1', steps:[], sections:[{title:'MFA',text:'MFA recovery'}]}));
      if (new Knowledge(books, 'auto').backend !== 'typescript') throw Error('fallback failed');
      let rejected = false; try { new Knowledge(books, 'rust'); } catch { rejected = true; }
      if (!rejected) throw Error('mandatory Rust did not reject missing artifact');`;
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        code,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const principal = { id: "eval", tenant: "demo", scopes: ["it"] };
const ids = (k: Knowledge, query: string, p = principal, limit = 3) =>
  k.search(p, query, limit).map((c) => c.id);

test("actual Rust WASM matches TypeScript for Turkish queries and ACL boundaries", () => {
  const corpus: Runbook[] = Array.from({ length: 180 }, (_, i) => ({
    ...books[i % books.length],
    id: `book-${i}`,
  }));
  const ts = new Knowledge(corpus, "typescript"),
    rust = new Knowledge(corpus, "rust");
  assert.equal(rust.backend, "rust");
  const queries = [
    "MFA telefon kurtarma",
    "OUTLOOK EŞİTLEME",
    "Windows VPN 809",
    "yazıcı çevrimdışı",
    "İ I ı i Ş ş",
    "SSH publickey",
    "OTHER_TENANT_PRIVATE",
    "zorbax",
    "ve bir",
    "",
    "MFA MFA telefon",
  ];
  for (const tenant of ["demo", "other-company", "unknown"]) {
    for (const scopes of [
      ["it"],
      ["engineering"],
      ["it", "engineering", "it"],
      [],
    ]) {
      for (const query of queries) {
        const p = { ...principal, tenant, scopes };
        for (const limit of [0, 1, 2, 3, 9, -1])
          assert.deepEqual(
            ids(rust, query, p, limit),
            ids(ts, query, p, limit),
            JSON.stringify({ query, tenant, scopes, limit }),
          );
      }
    }
  }
});

test("Rust preserves stable ties, relevance cutoff and independent knowledge instances", () => {
  const sample = books.filter((b) => b.tenant === "demo" && b.scope === "it");
  const first = new Knowledge(sample, "rust");
  const second = new Knowledge([...sample].reverse(), "rust");
  assert.deepEqual(
    ids(first, "MFA Outlook"),
    ids(new Knowledge(sample, "typescript"), "MFA Outlook"),
  );
  assert.deepEqual(
    ids(second, "MFA Outlook"),
    ids(new Knowledge([...sample].reverse(), "typescript"), "MFA Outlook"),
  );
  assert.deepEqual(ids(first, "MFA telefon"), ["mfa-device:1"]);
});

test("auto uses TypeScript for tiny corpora and Rust for larger snapshots", () => {
  assert.equal(new Knowledge(books, "auto").backend, "typescript");
  assert.equal(
    new Knowledge(
      Array.from({ length: 80 }, (_, i) => ({
        ...books[i % books.length],
        id: `large-${i}`,
      })),
      "auto",
    ).backend,
    "rust",
  );
});

test("WASM has no host imports and rejects malformed binary index input", () => {
  const module = new WebAssembly.Module(readFileSync("native/search.wasm"));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const engine: any = new WebAssembly.Instance(module, {}).exports;
  assert.equal(engine.abi_version(), 1);
  assert.equal(engine.input_resize(8_000_001), 0);
  let ptr = engine.input_resize(2);
  new Uint32Array(engine.memory.buffer, ptr, 2).set([1, 99]);
  assert.equal(engine.index_load(), 0);
  // Declares two terms but provides one pair: checked slices, no out-of-bounds read.
  ptr = engine.input_resize(6);
  new Uint32Array(engine.memory.buffer, ptr, 6).set([1, 0, 2, 2, 0, 2]);
  assert.equal(engine.index_load(), 0);
  assert.equal(engine.search(), 0);
});
