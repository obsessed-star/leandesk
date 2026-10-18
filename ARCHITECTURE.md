# Architecture

LeanDesk is a single-process support controller. eve hosts the channels; public support requests use the bounded controller rather than an extra free-running model session.

```mermaid
flowchart LR
  API[HTTP API] --> ID[Server identity bindings]
  TG[Telegram] --> V[Webhook verification]
  WA[WhatsApp] --> V
  V --> ID
  ID --> D[Persistent deduplication]
  D --> L[Runbook / answer cache]
  L --> R[Authorized BM25 retrieval]
  R --> B[Budget reservation]
  B --> G[Groq: at most two calls]
  G --> C[Schema and citation validation]
  C --> Reply[Reply with sources]
  ID --> T[Explicit draft / confirmation]
  T --> S[(Local SQLite queue)]
```

## Boundaries

`Runtime` resolves identity; request bodies cannot choose tenants or scopes. `Knowledge` filters records before scoring. `SupportAgent` owns case state, tool admission and budgets. `GroqProvider` handles deadlines, payload limits and reported usage. Channels authenticate transport then use the same controller. The default eve session endpoint is disabled.

The only model tool is `search_knowledge`, with one short query and server-supplied identity. No shell, browser, account mutation or ticket creation tool is exposed. Each retrieval keeps at most three authorized sections, discarding scores below 55% of the best BM25 match. Context is a byte-bounded JSON array of `{id,text}` records; complete section text is retained, including safety instructions. Oversized sections are skipped rather than truncated. Only packed evidence IDs can be cited. Only ambiguous evidence advertises the search tool. The second completion must be final; invalid output causes handoff without regeneration. Citation IDs must be a nonempty subset of supplied evidence. Semantic entailment is not proven automatically.

The initial prompt includes each question/attempt once. A second retrieval sends only new sections; previously supplied IDs remain valid for final citation checks. At most three initial and three additional sections can reach the model. Cache matching normalizes NFC, Turkish case and whitespace only: punctuation, accents, case facts and permission boundaries remain significant. This is not fuzzy or cross-user caching.

Document term frequencies are indexed once per `Knowledge` instance. Per-query document frequency and average length use only authorized documents. BM25 scores and ranking are preserved, with query work linear in authorized documents times query terms rather than rescanning the corpus inside every document score. Another tenant's documents cannot influence those statistics. `scripts/efficiency.ts` records offline request bytes, mock call counts and warm retrieval timing; it makes no new live-token or production-quality claim.

## Rust search backend

The Rust crate in `rust-search/` compiles to a dependency-free, import-free WASM module. Each knowledge snapshot owns one persistent instance and an inverted index of numeric term IDs, document lengths and tenant/scope group IDs. Normalization is shared with TypeScript, so Unicode/Turkish tokenization does not diverge. Rust computes authorized-corpus IDF, scores matching postings only and retains a stable top-three ranking. This changes the algorithm as well as the implementation language.

`auto` selects Rust at 64 sections or more when a valid artifact is available; otherwise TypeScript remains available. Explicit `rust` fails on an absent, stale or corrupt artifact. `typescript` forces the reference implementation. Loading checks source and binary hashes and rejects all host imports. The artifact is read from `native/` relative to the service working directory; ship `native/` and `rust-search/` with the repository deployment, alongside `knowledge/`. Node runs WASM directly, without per-query IPC or a native platform addon.

Input is a bounded u32 buffer with checked index parsing and no unsafe Rust. Every query supplies the authorized group IDs from server-owned principal bindings. Ranking statistics never mix tenants. Up to 256 MiB WASM linear memory and eight million input words are permitted; this pilot is not an unbounded search service. JS term-frequency maps are released after a Rust index loads, while query vocabulary/group maps remain available. Construction still tokenizes the source once and adds WASM indexing work. Benchmarks report construction separately from warm queries and include the host bridge.

`tests/rust-search.test.ts` compares actual WASM with TypeScript across Turkish queries, permissions, limits, stable ties, independent snapshots and malformed inputs. CI also forces all support-agent tests through the rebuilt Rust backend. `evidence/rust-search.json` is a synthetic local search benchmark, not evidence of faster Groq inference or lower billed tokens.

## Persistence and delivery

SQLite WAL stores redacted case facts, cached answers, events, delivery marks, tickets and per-owner metrics. Cases expire logically after 24 hours, drafts after 30 minutes and answer cache after 15 minutes. Expiration does not physically erase historical rows; automatic retention purge is not implemented.

Owner keys hash tenant, user ID and sorted scopes. Approved identity bindings can share an active case between channels. Scope changes produce a different owner/cache namespace. Event keys include transport identity and original conversation/message IDs.

In-process queues serialize case turns and delivery. Results are persisted before posting. An ordinary send failure retries the saved answer without another generation. A crash after platform acceptance but before marking delivery may duplicate a message; exactly-once external delivery is not claimed. Multiple application workers need shared locking and storage redesign.

## Cost accounting

Actual provider input/output tokens and cached input are recorded. Local answer-cache hits differ from provider prompt-cache discounts. Missing usage is recorded as an unreported call and blocks further model work for that case. Errors are not silently recorded as successful zero-cost completions.

Byte caps, output reservation, case usage and rolling daily call counts are checked before requests. Bytes are a conservative proxy, not an exact tokenizer. No automatic retry, critic model, embedding service or LLM summarizer is used.

## Verification and deployment

Offline tests cover control flow and adapter verification. Retrieval evaluation uses four synthetic queries. `evidence/live-groq.json` records real provider usage for two synthetic tasks and a local cache hit. Baseline usage was measured earlier in the same session and reused to avoid extra spend. This is not a production benchmark or a full live channel/tool-calling evaluation.

Node 24 and persistent writable disk are required. Edge runtimes and ephemeral serverless SQLite are unsuitable. Company deployment also needs SSO, reviewed knowledge ownership, backups, a retention policy, and an external ticket dispatcher if desired.
