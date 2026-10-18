import { defineChannel, GET, POST } from "eve/channels";
import { getRuntime } from "../../src/runtime.ts";

// The bounded controller is shared by HTTP, Telegram and WhatsApp. No default
// free-running eve session is started by these routes.
export default defineChannel({
  routes: [
    GET("/healthz", (request) => getRuntime().http(request)),
    GET("/api/metrics", (request) => getRuntime().http(request)),
    POST("/api/messages", (request) => getRuntime().http(request)),
    ...[
      "/admin",
      "/admin/assets/app",
      "/admin/assets/styles",
      "/admin/api/session",
      "/admin/api/overview",
      "/admin/api/knowledge",
    ].map((path) => GET(path, (request) => getRuntime().http(request))),
    ...[
      "/admin/api/login",
      "/admin/api/logout",
      "/admin/api/pause",
      "/admin/api/cache/clear",
      "/admin/api/ticket",
      "/admin/api/search",
    ].map((path) => POST(path, (request) => getRuntime().http(request))),
  ],
});
