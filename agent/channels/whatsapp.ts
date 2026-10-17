import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createMemoryState } from "@chat-adapter/state-memory";
import { chatSdkChannel } from "eve/channels/chat-sdk";
import { defineChannel, GET, POST } from "eve/channels";
import { getRuntime } from "../../src/runtime.ts";
import { deliver } from "../../src/delivery.ts";

const configured = [
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
].every((k) => !!process.env[k]);
function createChannel() {
  const { bot, channel } = chatSdkChannel({
    userName: "LeanDesk",
    adapters: { whatsapp: createWhatsAppAdapter({ userName: "LeanDesk" }) },
    state: createMemoryState(),
    streaming: false,
  });
  bot.onDirectMessage(async (thread, message) => {
    if (message.author.isMe || message.author.isBot === true || !message.text)
      return;
    await deliver(
      getRuntime(),
      "whatsapp",
      message.author.userId,
      thread.id,
      message.id,
      message.text,
      (text) => thread.post(text),
    );
  });
  return channel;
}
const unavailable = async () =>
  Response.json({ error: "channel_not_configured" }, { status: 503 });
export default configured
  ? createChannel()
  : defineChannel({
      routes: [
        GET("/eve/v1/whatsapp", unavailable),
        POST("/eve/v1/whatsapp", unavailable),
      ],
    });
