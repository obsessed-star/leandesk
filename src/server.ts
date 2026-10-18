import { createServer } from "node:http";
import { getRuntime } from "./runtime.ts";

const runtime = getRuntime();
const port = Number(process.env.PORT ?? 4321);
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 12_000) {
        res.writeHead(413);
        res.end("body_too_large");
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    const response = await runtime.http(
      new Request(
        new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`),
        {
          method: req.method,
          headers,
          ...(req.method !== "GET" && req.method !== "HEAD"
            ? { body: Buffer.concat(chunks) }
            : {}),
        },
      ),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end('{"error":"internal_error"}');
  }
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`LeanDesk API: http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () =>
    server.close(() => {
      runtime.agent.store.close();
      process.exit(0);
    }),
  );
