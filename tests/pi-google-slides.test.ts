import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoggedIn, login, presentationId, slidesClient } from "../pi/.pi/agent/extensions/google-slides/client";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-slides-test-"));
  await writeFile(join(dir, "client.json"), JSON.stringify({ installed: { client_id: "test-client", client_secret: "test-secret" } }));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function beginLogin(transport?: typeof fetch, timeoutMs?: number, signal?: AbortSignal) {
  const { promise: link, resolve, reject } = Promise.withResolvers<string>();
  const done = login({ dir, showLink: resolve, transport, timeoutMs, signal });
  void done.catch(reject);
  return { link, done };
}

test("OAuth prints a host-browser URL, checks state and PKCE, and stores a private refresh token", async () => {
  let tokenRequest: URLSearchParams | undefined;
  const transport = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://oauth2.googleapis.com/token");
    tokenRequest = init.body as URLSearchParams;
    return Response.json({ refresh_token: "fake-refresh", access_token: "do-not-persist" });
  }) as typeof fetch;
  const { done, link } = beginLogin(transport);
  const auth = new URL(await link);
  expect(auth.origin).toBe("https://accounts.google.com");
  expect(auth.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/presentations");
  expect(auth.searchParams.get("access_type")).toBe("offline");
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  expect(callback.hostname).toBe("127.0.0.1");
  callback.search = "?code=wrong&state=invalid";
  expect((await fetch(callback)).status).toBe(400);
  expect(tokenRequest).toBeUndefined();
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  callback.searchParams.set("code", "test-code");
  expect((await fetch(callback)).status).toBe(200);
  await done;
  expect(tokenRequest?.get("code")).toBe("test-code");
  expect(tokenRequest?.get("redirect_uri")).toBe(auth.searchParams.get("redirect_uri"));
  expect(createHash("sha256").update(tokenRequest!.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
  const token = join(dir, "token.json");
  expect(JSON.parse(await readFile(token, "utf8"))).toEqual({ refresh_token: "fake-refresh" });
  expect((await stat(token)).mode & 0o777).toBe(0o600);
  expect(await isLoggedIn(dir)).toBe(true);
});

test("OAuth cancellation closes the callback and doesn't write a token", async () => {
  const abort = new AbortController();
  const { link, done } = beginLogin(undefined, undefined, abort.signal);
  const redirect = new URL(await link).searchParams.get("redirect_uri")!;
  abort.abort();
  await expect(done).rejects.toThrow("cancelled");
  await expect(fetch(redirect)).rejects.toThrow();
  expect(await isLoggedIn(dir)).toBe(false);
});

test("Slides reads by URL and uses the required revision in native batchUpdate", async () => {
  await writeFile(join(dir, "token.json"), JSON.stringify({ refresh_token: "fake-refresh" }));
  const requests = [{ replaceAllText: { containsText: { text: "old", matchCase: true }, replaceText: "new" } }];
  const transport = (async (url: string, init: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      expect((init.body as URLSearchParams).get("refresh_token")).toBe("fake-refresh");
      return Response.json({ access_token: "fake-access" });
    }
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fake-access");
    if (init.method === "GET") {
      expect(new URL(url).pathname).toBe("/v1/presentations/my-deck");
      expect(new URL(url).searchParams.get("fields")).toBe("title,revisionId");
      return Response.json({ title: "Demo", revisionId: "revision-1" });
    }
    expect(url).toBe("https://slides.googleapis.com/v1/presentations/my-deck:batchUpdate");
    expect(JSON.parse(init.body as string)).toEqual({ writeControl: { requiredRevisionId: "revision-1" }, requests });
    return Response.json({ replies: [{ replaceAllText: { occurrencesChanged: 1 } }] });
  }) as typeof fetch;
  const client = slidesClient(dir, transport);
  const deck = await client.get("https://docs.google.com/presentation/d/my-deck/edit#slide=id.x", "title,revisionId");
  const result = await client.update("my-deck", deck.revisionId, requests);
  expect(result.replies[0].replaceAllText.occurrencesChanged).toBe(1);
  expect(() => client.update("my-deck", "  ", requests)).toThrow("revisionId");
  expect(() => presentationId("https://docs.google.com.evil.test/presentation/d/my-deck/edit")).toThrow();
});
