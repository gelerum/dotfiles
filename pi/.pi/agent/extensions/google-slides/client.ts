import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const scope = "https://www.googleapis.com/auth/presentations";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
export const hostLoginCommand = "just slides-login";

export function authDirectory() {
  return process.env.PI_SLIDES_AUTH_DIR || join(homedir(), ".config/pi-google-slides");
}

export async function isLoggedIn(dir = authDirectory()) {
  return Boolean(await refreshToken(dir));
}

async function clientCredentials(dir: string) {
  const path = join(dir, "client.json");
  const data = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") throw new Error(`Missing ${path}. Save a Google OAuth Desktop app client JSON there first.`);
    throw e;
  });
  const installed = JSON.parse(data)?.installed;
  if (typeof installed?.client_id !== "string" || !installed.client_id ||
      typeof installed?.client_secret !== "string" || !installed.client_secret) {
    throw new Error("client.json must be the downloaded Google OAuth Desktop app JSON.");
  }
  return { client_id: installed.client_id as string, client_secret: installed.client_secret as string };
}

async function refreshToken(dir: string): Promise<string | undefined> {
  const data = await readFile(join(dir, "token.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (data === undefined) return undefined;
  const token = JSON.parse(data)?.refresh_token;
  if (typeof token !== "string" || !token) throw new Error(`Invalid Slides token file. Run ${hostLoginCommand} on the host or /slides-login outside devenv.`);
  return token;
}

async function storeToken(dir: string, token: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.token-${randomBytes(12).toString("hex")}`);
  await writeFile(temp, JSON.stringify({ refresh_token: token }) + "\n", { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, join(dir, "token.json"));
  } finally {
    await rm(temp, { force: true });
  }
}

function boundedSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function requestToken(values: Record<string, string>, transport: typeof fetch, signal?: AbortSignal) {
  const response = await transport(tokenEndpoint, {
    method: "POST", body: new URLSearchParams(values), signal: boundedSignal(signal), redirect: "error",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = result?.error === "invalid_grant" ? ` Run ${hostLoginCommand} on the host (or /slides-login outside devenv).` : "";
    throw new Error(`Google OAuth token exchange failed (HTTP ${response.status}).${hint}`);
  }
  return result;
}

export async function login({ dir = authDirectory(), port = 0, container = false, showLink,
  transport = fetch, timeoutMs = 300_000, signal }: {
  dir?: string; port?: number; container?: boolean; showLink: (url: string) => void;
  transport?: typeof fetch; timeoutMs?: number; signal?: AbortSignal;
}) {
  const credentials = await clientCredentials(dir);
  const deadline = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  abort.throwIfAborted();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Container mode is used only by the one-shot Compose command with a host loopback publish.
      server.listen(port, container ? "0.0.0.0" : "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback did not bind.");
    const redirect = new URL(`http://127.0.0.1:${address.port}/oauth2callback`);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: credentials.client_id, redirect_uri: redirect.href, response_type: "code", scope,
      state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent",
    }).toString();
    await new Promise<void>((resolve, reject) => {
      let exchanging = false;
      const aborted = () => reject(new Error(deadline.aborted ? "Google Slides login timed out." : "Google Slides login cancelled."));
      server.on("request", async (req, res) => {
        const reply = (status: number, text: string) => {
          res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
          res.end(text + "\n");
        };
        if (req.method !== "GET" || req.headers.host !== redirect.host || !req.url?.startsWith("/oauth2callback?")) {
          return reply(404, "Not found");
        }
        const params = new URLSearchParams(req.url.slice("/oauth2callback?".length));
        const returned = Buffer.from(params.get("state") ?? "");
        const expected = Buffer.from(state);
        if (returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
          return reply(400, "Invalid OAuth state. Use the original sign-in link.");
        }
        if (exchanging) return reply(409, "This OAuth callback is already being handled.");
        exchanging = true;
        try {
          const code = params.get("code");
          if (params.has("error") || !code) throw new Error("Google authorization was denied or cancelled.");
          const result = await requestToken({ ...credentials, code, code_verifier: verifier,
            redirect_uri: redirect.href, grant_type: "authorization_code" }, transport, abort);
          if (typeof result.refresh_token !== "string" || !result.refresh_token) {
            throw new Error("Google did not return a refresh token. Try signing in again.");
          }
          abort.throwIfAborted();
          await storeToken(dir, result.refresh_token);
          reply(200, "Google Slides connected. You can close this tab.");
          resolve();
        } catch (err) {
          reply(400, "Google Slides login failed. See the terminal for details.");
          reject(err);
        }
      });
      if (abort.aborted) aborted();
      else {
        abort.addEventListener("abort", aborted, { once: true });
        server.once("close", () => abort.removeEventListener("abort", aborted));
        showLink(url.href);
      }
    });
  } finally {
    // Close the listener even for denial, Ctrl+C, timeout, or failure to show the link.
    server.close();
    if (abort.aborted) server.closeAllConnections();
    else server.closeIdleConnections();
  }
}

export function presentationId(input: string) {
  const value = input.trim();
  const id = /^[\w-]+$/.test(value) ? value :
    /^https:\/\/docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)(?:[/?#]|$)/.exec(value)?.[1];
  if (!id) throw new Error("Provide a Google Slides presentation ID or a docs.google.com/presentation URL.");
  return id;
}

export function slidesClient(dir = authDirectory(), transport = fetch) {
  async function call(path: string, body?: object, signal?: AbortSignal) {
    const token = await refreshToken(dir);
    if (!token) throw new Error(`Google Slides is not connected. Run ${hostLoginCommand} on the devenv host (or /slides-login outside devenv).`);
    const credentials = await clientCredentials(dir);
    const result = await requestToken({ ...credentials, refresh_token: token, grant_type: "refresh_token" }, transport, signal);
    if (typeof result.access_token !== "string" || !result.access_token) throw new Error("Google did not return an access token.");
    const response = await transport(`https://slides.googleapis.com/v1/presentations/${path}`, {
      method: body ? "POST" : "GET", signal: boundedSignal(signal), redirect: "error",
      headers: { Authorization: `Bearer ${result.access_token}`, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    const output = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`Google Slides API (HTTP ${response.status}): ${String(output?.error?.message ?? response.statusText).slice(0, 1000)}`);
    return output;
  }
  return {
    get(input: string, fields?: string, signal?: AbortSignal) {
      const query = fields ? `?${new URLSearchParams({ fields })}` : "";
      return call(presentationId(input) + query, undefined, signal);
    },
    update(input: string, revisionId: string, requests: Record<string, unknown>[], signal?: AbortSignal) {
      if (!revisionId.trim()) throw new Error("Read the presentation and supply its current revisionId before editing.");
      return call(`${presentationId(input)}:batchUpdate`, { writeControl: { requiredRevisionId: revisionId }, requests }, signal);
    },
  };
}
