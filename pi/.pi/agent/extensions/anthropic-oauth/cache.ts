import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export type CacheControl = { type: "ephemeral"; ttl?: "1h" };

// Explicit request options take precedence over credential-scoped and process env.
// Match Pi's default short retention and honor "none" for one-off summaries.
export function getCacheControl(
  options?: Pick<SimpleStreamOptions, "cacheRetention" | "env">,
  supportsLongCacheRetention = true,
): CacheControl | null {
  const envRetention = options?.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION;
  const retention = options?.cacheRetention ?? (envRetention === "long" ? "long" : "short");
  if (retention === "none") return null;
  return {
    type: "ephemeral",
    ...(retention === "long" && supportsLongCacheRetention ? { ttl: "1h" as const } : {}),
  };
}
