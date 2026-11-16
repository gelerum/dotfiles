import { afterEach, expect, test } from "bun:test";
import { getCacheControl } from "../pi/.pi/agent/extensions/anthropic-oauth/cache.ts";
import { buildAnthropicSystemPrompt } from "../pi/.pi/agent/extensions/anthropic-oauth/prompt.ts";
import { convertPiMessagesToAnthropic } from "../pi/.pi/agent/extensions/anthropic-oauth/convert.ts";

const oldEnv = process.env.PI_CACHE_RETENTION;
afterEach(() => {
  if (oldEnv === undefined) delete process.env.PI_CACHE_RETENTION;
  else process.env.PI_CACHE_RETENTION = oldEnv;
});
const model = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" } as const;
const user = [{ role: "user", content: "hello", timestamp: 0 }] as any;

test("default stays short, env long adds one-hour TTL, explicit options win", () => {
  delete process.env.PI_CACHE_RETENTION;
  expect(getCacheControl()).toEqual({ type: "ephemeral" });
  process.env.PI_CACHE_RETENTION = "long";
  expect(getCacheControl()).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(getCacheControl({ cacheRetention: "short" })).toEqual({ type: "ephemeral" });
  expect(getCacheControl({ cacheRetention: "none" })).toBeNull();
  expect(getCacheControl({ env: { PI_CACHE_RETENTION: "short" } })).toEqual({ type: "ephemeral" });
  expect(getCacheControl({ env: { PI_CACHE_RETENTION: "long" } })).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(getCacheControl({ cacheRetention: "long" }, false)).toEqual({ type: "ephemeral" });
});

test("system and plain-text user breakpoints receive the same long TTL", () => {
  const cache = getCacheControl({ cacheRetention: "long" });
  const system = buildAnthropicSystemPrompt("Stable instructions", true, cache)!;
  expect(system[0].cache_control).toBeUndefined();
  expect(system[1].cache_control).toBeUndefined();
  expect(system.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  const messages = convertPiMessagesToAnthropic(user, true, model, cache);
  expect((messages.at(-1)!.content as any[]).at(-1).cache_control).toEqual(cache);
});

test("none removes every breakpoint while keeping OAuth identity", () => {
  const cache = getCacheControl({ cacheRetention: "none" });
  const system = buildAnthropicSystemPrompt("Stable instructions", true, cache)!;
  expect(system).toHaveLength(3);
  expect(system.every((b) => b.cache_control === undefined)).toBe(true);
  const messages = convertPiMessagesToAnthropic(user, true, model, cache);
  expect(JSON.stringify(messages)).not.toContain("cache_control");
});

test("image and tool-result blocks receive long TTL without mutating input", () => {
  const cache = getCacheControl({ cacheRetention: "long" });
  const imageUser = [{ role: "user", timestamp: 0, content: [
    { type: "text", text: "image" }, { type: "image", data: "AAAA", mimeType: "image/png" },
  ] }] as any;
  const toolHistory = [
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "a" } }] },
    { role: "toolResult", toolCallId: "call1", toolName: "read", timestamp: 0,
      content: [{ type: "text", text: "result" }], isError: false },
  ] as any;
  for (const history of [imageUser, toolHistory]) {
    const before = JSON.stringify(history);
    const messages = convertPiMessagesToAnthropic(history, true, model, cache);
    expect((messages.at(-1)!.content as any[]).at(-1).cache_control).toEqual(cache);
    expect(JSON.stringify(history)).toBe(before);
  }
});
