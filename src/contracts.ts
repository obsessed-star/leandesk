export type Channel = "api" | "telegram" | "whatsapp";
export interface Principal {
  id: string;
  tenant: string;
  scopes: string[];
}
export interface RequestInput {
  principal: Principal;
  channel: Channel;
  conversation: string;
  eventId: string;
  message: string;
}
export interface Usage {
  input: number;
  output: number;
  cachedInput: number;
  calls: number;
  unreportedCalls?: number;
}
export interface Citation {
  id: string;
  title: string;
  section: string;
  revision: string;
}
export interface Answer {
  text: string;
  route:
    | "runbook"
    | "cache"
    | "rag"
    | "clarify"
    | "handoff"
    | "ticket"
    | "resolved";
  citations: Citation[];
  usage: Usage;
  replayed?: boolean;
  ticketId?: string;
}
export interface Chunk extends Citation {
  tenant: string;
  scope: string;
  text: string;
}
export interface Runbook {
  id: string;
  tenant: string;
  scope: string;
  title: string;
  revision: string;
  errorCode?: string;
  requiredTerms?: string[];
  question?: string;
  steps: string[];
  sections: { title: string; text: string }[];
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Completion {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
}
export interface Provider {
  complete(
    messages: ModelMessage[],
    maxOutput: number,
    allowSearch: boolean,
  ): Promise<Completion>;
}
export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cachedInput: 0,
  calls: 0,
});
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cachedInput: a.cachedInput + b.cachedInput,
    calls: a.calls + b.calls,
    ...((a.unreportedCalls ?? 0) + (b.unreportedCalls ?? 0) > 0
      ? { unreportedCalls: (a.unreportedCalls ?? 0) + (b.unreportedCalls ?? 0) }
      : {}),
  };
}
export function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i");
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:gsk_[\w-]+|sk-[\w-]+|ghp_[\w]+)\b/g, "[SECRET]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(
      /\b(?:password|parola|sifre|şifre|token|api[_ -]?key)\s*[:=]\s*\S+/gi,
      "[SECRET]",
    );
}
