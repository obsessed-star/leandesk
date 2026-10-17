import { createHash } from "node:crypto";
import { eventKey, renderAnswer } from "./agent.ts";
import type { Channel } from "./contracts.ts";
import type { Runtime } from "./runtime.ts";

const locks = new Map<string, Promise<unknown>>();
export async function deliver(
  runtime: Runtime,
  channel: Channel,
  subject: string,
  conversation: string,
  eventId: string,
  message: string,
  post: (text: string) => Promise<unknown>,
): Promise<boolean> {
  const principal = runtime.identify(channel, subject);
  if (!principal) return false;
  // Only administrator-approved identity bindings share an active case across
  // channels. Platform display names never establish this link.
  const input = {
      principal,
      channel,
      conversation: "active",
      eventId: createHash("sha256")
        .update(JSON.stringify([conversation, eventId]))
        .digest("hex"),
      message,
    },
    key = eventKey(input);
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      if (runtime.agent.store.delivered(key)) return false;
      const result = await runtime.agent.handle(input);
      await post(renderAnswer(result));
      runtime.agent.store.markDelivered(key);
      return true;
    });
  locks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (locks.get(key) === pending) locks.delete(key);
  }
}
