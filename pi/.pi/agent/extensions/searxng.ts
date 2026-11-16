/**
 * SearXNG extension для pi
 *
 * Заменяет DuckDuckGo на локальный SearXNG instance.
 * Требует URL SearXNG (например, http://localhost:8080)
 *
 * Сейчас в режиме "disabled" — когда будешь готов,
 * впиши URL в настройке ниже.
 */

import { execFile } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { mkdtemp, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

// ============================================================
// НАСТРОЙКА: впиши сюда URL твоего SearXNG
// ============================================================
const SEARXNG_URL = ""; // например: "http://localhost:8080" или "http://searxng:8080"
// ============================================================

// Поиск SearXNG по API
// Документация: https://docs.searxng.org/dev/search_api.html
async function searxngSearch(
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  if (!SEARXNG_URL) {
    throw new Error(
      "SearXNG URL not configured. Set SEARXNG_URL in searxng.ts to use this search engine."
    );
  }

  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
    categories: "general",
    lang: "auto",
    safesearch: "0",
  });

  const timeout = AbortSignal.timeout(30_000);
  const res = await fetch(
    `${SEARXNG_URL}/search?${params}`,
    {
      headers: { "User-Agent": UA },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }
  );

  if (!res.ok) {
    throw new Error(`SearXNG HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as SearXNGResponse;

  return (data.results ?? [])
    .map((r: SearXNGResult) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, limit);
}

// --- Типы ---

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearXNGResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
  suggestions?: string[];
  query?: string;
}

// --- Утилита для парсинга ---

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Расширение ---

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "searxng_search",
    label: "SearXNG Search",
    description:
      "Search the web via SearXNG (local instance). " +
      (SEARXNG_URL
        ? `Instance: ${SEARXNG_URL}`
        : "⚠️ NOT CONFIGURED — set SEARXNG_URL in searxng.ts to enable."),
    promptSnippet: "searxng_search: Search via SearXNG",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results, default 8" })
      ),
    }),

    async execute(_id, params, signal) {
      const limit = Math.max(1, Math.min(params.limit ?? 8, 20));

      let results: SearchResult[];
      let note = "";
      try {
        results = await searxngSearch(params.query, limit, signal);
      } catch (err) {
        note = `${(err as Error).message}\n\n`;
        // Fallback на DuckDuckGo если SearXNG не работает
        note += "Falling back to DuckDuckGo. Consider fixing SearXNG config.\n\n";
        results = [];
      }

      if (!results.length) {
        return {
          content: [
            { type: "text", text: `${note}No results` },
          ],
          details: { count: 0, fallback: true } as {
            count: number;
            fallback: boolean;
          },
        };
      }

      const text = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`
        )
        .join("\n\n");

      return {
        content: [
          { type: "text", text: `${note}${text}` },
        ],
        details: { count: results.length, fallback: false } as {
          count: number;
          fallback: boolean;
        },
      };
    },
  });

  // Альтернативный: поиск только SearXNG (без fallback)
  pi.registerTool({
    name: "searxng_search_strict",
    label: "SearXNG Search (strict)",
    description:
      "Search via SearXNG only. No fallback. Throws error if SearXNG is unavailable.",
    promptSnippet: "searxng_search_strict: Search via SearXNG (strict, no fallback)",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results, default 8" })
      ),
    }),

    async execute(_id, params, signal) {
      const limit = Math.max(1, Math.min(params.limit ?? 8, 20));

      const results = await searxngSearch(params.query, limit, signal);

      if (!results.length) {
        return {
          content: [
            { type: "text", text: "No results from SearXNG" },
          ],
          details: { count: 0 } as { count: number },
        };
      }

      const text = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { count: results.length },
      };
    },
  });
}
