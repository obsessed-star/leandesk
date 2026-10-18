import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const cargo = process.env.CARGO ?? "cargo";
const build = spawnSync(
  cargo,
  [
    "build",
    "--manifest-path",
    "rust-search/Cargo.toml",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, RUSTFLAGS: "-C link-arg=--max-memory=268435456" },
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const bytes = readFileSync(
  "rust-search/target/wasm32-unknown-unknown/release/leandesk_search.wasm",
);
const source = ["rust-search/Cargo.toml", "rust-search/src/lib.rs"]
  .map((path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
  .join("\n");
const sha = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
mkdirSync("native", { recursive: true });
writeFileSync("native/search.wasm", bytes);
writeFileSync(
  "native/manifest.json",
  JSON.stringify(
    {
      abi: 1,
      sourceSha256: sha(source),
      wasmSha256: sha(bytes),
      bytes: bytes.length,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built Rust search WASM (${bytes.length} bytes).`);
