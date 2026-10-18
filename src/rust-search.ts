import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Chunk, Principal } from "./contracts.ts";

export type TermIndex = { length: number; frequency: Map<string, number> };
export type SearchBackend = "auto" | "typescript" | "rust";
interface Engine {
  memory: WebAssembly.Memory;
  abi_version(): number;
  input_resize(length: number): number;
  index_load(): number;
  search(): number;
  result_ptr(): number;
}
let compiled: WebAssembly.Module | undefined;
const sha = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
function loadModule(): WebAssembly.Module {
  if (compiled) return compiled;
  const binary = readFileSync(resolve("native/search.wasm"));
  const manifest = JSON.parse(
    readFileSync(resolve("native/manifest.json"), "utf8"),
  );
  const source = ["rust-search/Cargo.toml", "rust-search/src/lib.rs"]
    .map((path) => readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n"))
    .join("\n");
  if (
    manifest.abi !== 1 ||
    manifest.sourceSha256 !== sha(source) ||
    manifest.wasmSha256 !== sha(binary)
  )
    throw Error(
      "Rust search artifact is stale or corrupted; run npm run build:rust.",
    );
  const module = new WebAssembly.Module(binary);
  if (WebAssembly.Module.imports(module).length)
    throw Error("Search WASM must have no host imports.");
  compiled = module;
  return module;
}

/** One persistent WASM instance per knowledge snapshot; no child process per query. */
export class RustSearch {
  private readonly engine: Engine;
  private readonly termIds = new Map<string, number>();
  private readonly groupIds = new Map<string, number>();
  constructor(chunks: Chunk[], tokens: Map<Chunk, TermIndex>) {
    this.engine = new WebAssembly.Instance(loadModule(), {})
      .exports as unknown as Engine;
    if (this.engine.abi_version() !== 1) throw Error("Unsupported search ABI.");
    const data: number[] = [chunks.length];
    for (const chunk of chunks) {
      const key = JSON.stringify([chunk.tenant, chunk.scope]);
      if (!this.groupIds.has(key)) this.groupIds.set(key, this.groupIds.size);
      const index = tokens.get(chunk)!;
      data.push(this.groupIds.get(key)!, index.length, index.frequency.size);
      for (const [term, count] of index.frequency) {
        if (!this.termIds.has(term)) this.termIds.set(term, this.termIds.size);
        data.push(this.termIds.get(term)!, count);
      }
    }
    this.write(data);
    if (this.engine.index_load() !== 1)
      throw Error("Invalid Rust search index.");
  }
  private write(data: number[]) {
    const ptr = this.engine.input_resize(data.length);
    if (!ptr || ptr % 4) throw Error("Search input exceeds WASM buffer limit.");
    new Uint32Array(this.engine.memory.buffer, ptr, data.length).set(data);
  }
  search(principal: Principal, terms: string[], limit: number): number[] {
    const groups = [...new Set(principal.scopes)]
      .map((scope) =>
        this.groupIds.get(JSON.stringify([principal.tenant, scope])),
      )
      .filter((id): id is number => id !== undefined);
    const ids = terms
      .map((term) => this.termIds.get(term))
      .filter((id): id is number => id !== undefined);
    if (!groups.length || !ids.length || limit <= 0) return [];
    this.write([limit, groups.length, ...groups, ids.length, ...ids]);
    const count = this.engine.search();
    if (count > 3) throw Error("Invalid search result length.");
    return Array.from(
      new Uint32Array(
        this.engine.memory.buffer,
        this.engine.result_ptr(),
        count,
      ),
    );
  }
}
