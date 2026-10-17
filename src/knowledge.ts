import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  normalize,
  type Chunk,
  type Principal,
  type Runbook,
} from "./contracts.ts";

const words = (s: string): string[] =>
  normalize(s).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
const stop = new Set([
  "bir",
  "ve",
  "ile",
  "icin",
  "olan",
  "bu",
  "the",
  "and",
  "for",
  "is",
  "my",
  "nasil",
]);
export class Knowledge {
  readonly chunks: Chunk[];
  readonly revision: string;
  private readonly tokens: Map<
    Chunk,
    { length: number; frequency: Map<string, number> }
  >;
  constructor(readonly books: Runbook[]) {
    // A content digest invalidates cached answers whenever any runbook changes.
    this.revision = createHash("sha256")
      .update(JSON.stringify(books))
      .digest("hex");
    this.chunks = books.flatMap((b) =>
      b.sections.map((s, i) => ({
        id: `${b.id}:${i + 1}`,
        title: b.title,
        section: s.title,
        revision: b.revision,
        tenant: b.tenant,
        scope: b.scope,
        text: s.text,
      })),
    );
    // Index immutable document text once. Query statistics below still use only
    // the authorized corpus, so another tenant cannot affect relevance scores.
    this.tokens = new Map(
      this.chunks.map((chunk) => {
        const terms = words(`${chunk.title} ${chunk.section} ${chunk.text}`);
        const frequency = new Map<string, number>();
        for (const term of terms)
          frequency.set(term, (frequency.get(term) ?? 0) + 1);
        return [chunk, { length: terms.length, frequency }];
      }),
    );
  }
  static load(path = "knowledge/runbooks.json") {
    return new Knowledge(JSON.parse(readFileSync(path, "utf8")) as Runbook[]);
  }
  allowed(p: Principal) {
    return this.chunks.filter(
      (c) => c.tenant === p.tenant && p.scopes.includes(c.scope),
    );
  }
  fastPath(p: Principal, query: string): Runbook | undefined {
    const q = normalize(query);
    return this.books.find(
      (b) =>
        b.tenant === p.tenant &&
        p.scopes.includes(b.scope) &&
        !!b.errorCode &&
        new RegExp(`\\b${b.errorCode}\\b`, "i").test(q) &&
        (b.requiredTerms ?? []).every((term) => q.includes(normalize(term))),
    );
  }
  search(p: Principal, query: string, limit = 3): Chunk[] {
    const corpus = this.allowed(p),
      terms = [...new Set(words(query).filter((w) => !stop.has(w)))];
    if (!terms.length || !corpus.length) return [];
    const tokenized = corpus.map((c) => this.tokens.get(c)!);
    const avg = tokenized.reduce((n, t) => n + t.length, 0) / corpus.length;
    const idfs = new Map(
      terms.map((term) => {
        const df = tokenized.reduce(
          (n, doc) => n + Number(doc.frequency.has(term)),
          0,
        );
        return [term, Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5))];
      }),
    );
    // BM25 stays local: retrieval itself spends no Groq tokens and needs no
    // remote embedding service. Authorization happens BEFORE corpus scoring.
    const ranked = corpus
      .map((chunk, i) => ({
        chunk,
        score: terms.reduce((score, term) => {
          const tf = tokenized[i].frequency.get(term) ?? 0;
          const idf = idfs.get(term)!;
          return (
            score +
            (idf * tf * 2.2) /
              (tf + 1.2 * (0.25 + (0.75 * tokenized[i].length) / avg))
          );
        }, 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    // Suppress weak lexical matches: extra context and an unnecessary search
    // plan can cost more than sending the strongest runbook directly.
    const floor = (ranked[0]?.score ?? 0) * 0.55;
    return ranked
      .filter((x) => x.score >= floor)
      .slice(0, Math.min(3, limit))
      .map((x) => x.chunk);
  }
  context(chunks: Chunk[], maxBytes = 2600): string {
    return JSON.stringify(
      this.pack(chunks, maxBytes).map((c) => ({ id: c.id, text: c.text })),
    );
  }
  pack(chunks: Chunk[], maxBytes = 2600): Chunk[] {
    const packed: Chunk[] = [];
    let bytes = 2; // JSON array delimiters; skip oversized sections, never cut safety text.
    for (const c of chunks) {
      const size =
        Buffer.byteLength(JSON.stringify({ id: c.id, text: c.text })) +
        Number(packed.length > 0);
      if (bytes + size > maxBytes) continue;
      packed.push(c);
      bytes += size;
    }
    return packed;
  }
}
