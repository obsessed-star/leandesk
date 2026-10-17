import { defineChannel, GET, POST } from "eve/channels";
import { getRuntime } from "../../src/runtime.ts";

// The bounded controller is shared by HTTP, Telegram and WhatsApp. No default
// free-running eve session is started by these routes.
export default defineChannel({
  routes: [
    GET("/healthz", (request) => getRuntime().http(request)),
    GET("/api/metrics", (request) => getRuntime().http(request)),
    POST("/api/messages", (request) => getRuntime().http(request)),
  ],
});
