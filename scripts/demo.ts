import { SupportAgent } from "../src/agent.ts";
import { Knowledge } from "../src/knowledge.ts";
import { Store } from "../src/store.ts";

const store = new Store(":memory:");
const agent = new SupportAgent(store, Knowledge.load());
const principal = { id: "demo-user", tenant: "demo", scopes: ["it"] };
let sequence = 0;
for (const message of ["Windows VPN 809 hatası", "/ticket"]) {
  const a = await agent.handle({
    principal,
    channel: "api",
    conversation: "demo",
    eventId: String(++sequence),
    message,
  });
  console.log(JSON.stringify({ question: message, ...a }, null, 2));
  if (a.ticketId) {
    const confirmed = await agent.handle({
      principal,
      channel: "api",
      conversation: "demo",
      eventId: String(++sequence),
      message: "/confirm " + a.ticketId,
    });
    console.log(JSON.stringify(confirmed, null, 2));
  }
}
store.close();
