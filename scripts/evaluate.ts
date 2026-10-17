import assert from "node:assert/strict";
import { Knowledge } from "../src/knowledge.ts";

const cases: [string, string][] = [
  ["VPN Windows 809 bağlantısı kurulamadı", "vpn-809:1"],
  ["Outlook e-posta eşitleme çevrimdışı", "mail-profile:1"],
  ["Telefon değişti MFA kurtarma", "mfa-device:1"],
  ["Yazıcı çevrimdışı yazdırma kuyruğu", "printer-offline:1"],
];
const knowledge = Knowledge.load(),
  principal = { id: "eval", tenant: "demo", scopes: ["it"] };
const results = cases.map(([query, expected]) => {
  const found = knowledge.search(principal, query);
  return {
    query,
    expected,
    top1: found[0]?.id ?? null,
    hitAt3: found.some((c) => c.id === expected),
  };
});
assert.ok(results.every((r) => r.hitAt3));
console.log(
  JSON.stringify(
    {
      mode: "offline-retrieval",
      dataset: "4 synthetic IT queries; not a production quality benchmark",
      recallAt3: results.filter((r) => r.hitAt3).length / results.length,
      results,
    },
    null,
    2,
  ),
);
