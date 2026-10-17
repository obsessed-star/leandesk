import { z } from "zod";
import type { Completion, ModelMessage, Provider, Usage } from "./contracts.ts";

export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_knowledge",
    description: "Search approved IT runbooks with a more specific query.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", maxLength: 180 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds = 0,
    readonly usage?: Usage,
  ) {
    super(code);
  }
}
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().optional() })
    .optional(),
});
export class GroqProvider implements Provider {
  private cooldownUntil = 0;
  constructor(
    private key: string,
    readonly model = process.env.GROQ_MODEL ?? "qwen/qwen3.8-27b",
    private transport: typeof fetch = fetch,
  ) {}
  async complete(
    messages: ModelMessage[],
    maxOutput: number,
    allowSearch: boolean,
  ): Promise<Completion> {
    if (Date.now() < this.cooldownUntil)
      throw new ProviderError(
        "provider_cooldown",
        Math.ceil((this.cooldownUntil - Date.now()) / 1000),
      );
    const body = {
      model: this.model,
      messages,
      max_completion_tokens: maxOutput,
      temperature: 0,
      ...(this.model.startsWith("qwen/")
        ? { reasoning_effort: "none" }
        : this.model.startsWith("openai/gpt-oss-")
          ? { reasoning_effort: "low" }
          : {}),
      ...(allowSearch
        ? {
            tools: [SEARCH_TOOL],
            tool_choice: "auto",
            parallel_tool_calls: false,
          }
        : { response_format: { type: "json_object" } }),
    };
    // UTF-8 bytes are a conservative preflight proxy, not reported token usage.
    if (Buffer.byteLength(JSON.stringify(body)) > 12_000)
      throw new ProviderError("input_budget_exceeded");
    let response: Response;
    try {
      response = await this.transport(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new ProviderError("provider_unavailable", 0, {
        input: 0,
        output: 0,
        cachedInput: 0,
        calls: 1,
        unreportedCalls: 1,
      });
    }
    if (!response.ok) {
      const unknown = {
        input: 0,
        output: 0,
        cachedInput: 0,
        calls: 1,
        unreportedCalls: 1,
      };
      if (response.status === 429) {
        const retry = Math.min(
          3600,
          Math.max(1, Number(response.headers.get("retry-after")) || 60),
        );
        this.cooldownUntil = Date.now() + retry * 1000;
        throw new ProviderError("rate_limited", retry, unknown);
      }
      let remoteCode = "";
      try {
        const data: any = await response.json();
        if (typeof data.error?.code === "string")
          remoteCode = data.error.code
            .replace(/[^a-zA-Z0-9_]/g, "")
            .slice(0, 60);
      } catch {}
      throw new ProviderError(
        response.status === 401
          ? "provider_auth_failed"
          : `provider_http_${response.status}${remoteCode ? "_" + remoteCode : ""}`,
        0,
        unknown,
      );
    }
    let raw: any;
    try {
      raw = await response.json();
    } catch {
      throw new ProviderError("invalid_provider_response", 0, {
        input: 0,
        output: 0,
        cachedInput: 0,
        calls: 1,
        unreportedCalls: 1,
      });
    }
    const usage = usageSchema.safeParse(raw.usage),
      message = raw.choices?.[0]?.message;
    const reported = usage.success
      ? {
          input: usage.data.prompt_tokens,
          output: usage.data.completion_tokens,
          cachedInput: usage.data.prompt_tokens_details?.cached_tokens ?? 0,
          calls: 1,
        }
      : undefined;
    if (
      !usage.success ||
      !message ||
      raw.choices?.[0]?.finish_reason === "length"
    )
      throw new ProviderError(
        "incomplete_provider_response",
        0,
        reported ?? {
          input: 0,
          output: 0,
          cachedInput: 0,
          calls: 1,
          unreportedCalls: 1,
        },
      );
    const toolCalls = z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("function"),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .safeParse(message.tool_calls ?? []);
    if (!toolCalls.success)
      throw new ProviderError("invalid_provider_response", 0, reported);
    return {
      content: typeof message.content === "string" ? message.content : null,
      toolCalls: toolCalls.data,
      usage: {
        input: usage.data.prompt_tokens,
        output: usage.data.completion_tokens,
        cachedInput: usage.data.prompt_tokens_details?.cached_tokens ?? 0,
        calls: 1,
      },
    };
  }
}
