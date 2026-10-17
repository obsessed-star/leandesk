import { telegramChannel } from "eve/channels/telegram";
import { defineChannel, POST } from "eve/channels";
import { getRuntime } from "../../src/runtime.ts";
import { deliver } from "../../src/delivery.ts";

const configured =
  !!process.env.TELEGRAM_BOT_TOKEN &&
  !!process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
export default configured
  ? telegramChannel({
      botUsername: process.env.TELEGRAM_BOT_USERNAME,
      async onMessage(ctx, message) {
        // Private knowledge must never be posted into a group conversation.
        if (
          message.chat.type !== "private" ||
          !message.from ||
          message.from.isBot ||
          !message.text
        )
          return null;
        await deliver(
          getRuntime(),
          "telegram",
          message.from.id,
          message.chat.id,
          message.messageId,
          message.text,
          (text) => ctx.telegram.post(text),
        );
        // The controller already answered; do not start an additional model turn.
        return null;
      },
    })
  : defineChannel({
      routes: [
        POST("/eve/v1/telegram", async () =>
          Response.json({ error: "channel_not_configured" }, { status: 503 }),
        ),
      ],
    });
