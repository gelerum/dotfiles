/**
 * Веб без API-ключей: web_fetch (страница или PDF -> текст) и web_search (DuckDuckGo).
 *
 * - HTML -> markdown без зависимостей: основной блок страницы (main/article/...), без скриптов,
 *   меню и подвалов; заголовки, ссылки, списки, код, таблицы, формулы MathML -> $LaTeX$
 * - PDF -> текст через pdftotext (poppler-utils)
 * - arXiv: /abs/<id> -> HTML-версия статьи (arxiv.org/html), если её нет - PDF
 * - длинный текст обрезается, полный - во временном файле, путь сообщается модели
 * - web_search разбирает HTML-выдачу html.duckduckgo.com: это скрапинг, может сломаться
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

// --- загрузка

async function download(url: string, signal?: AbortSignal, init: RequestInit = {}) {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(url, {
		redirect: "follow",
		...init,
		headers: { "user-agent": UA, "accept-language": "en,ru;q=0.8", ...(init.headers as Record<string, string>) },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	// Читаем потоком, чтобы не скачать гигабайт по ошибке
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = res.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_DOWNLOAD) {
			await reader.cancel();
			throw new Error(`response is larger than ${formatSize(MAX_DOWNLOAD)}`);
		}
		chunks.push(value);
	}
	return { res, body: Buffer.concat(chunks) };
}

async function pdfToText(pdf: Buffer): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-pdf-"));
	const file = join(dir, "doc.pdf");
	await writeFile(file, pdf);
	try {
		// Без -layout: двухколоночные статьи читаются по колонкам, а не построчно через обе
		const { stdout } = await run("pdftotext", ["-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024 });
		return stdout.replace(/\f/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
	} catch (err: any) {
		if (err.code === "ENOENT") throw new Error("pdftotext not found: install poppler-utils");
		throw new Error(`pdftotext failed: ${err.stderr || err.message}`);
	}
}

// --- HTML -> markdown

const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
	laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", bull: "•",
	copy: "©", reg: "®", times: "×", minus: "−", deg: "°", plusmn: "±", micro: "µ", para: "¶", sect: "§",
};

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

function attr(tag: string, name: string): string | undefined {
	const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

// Содержимое первого элемента, открывающий тег которого подходит под re, с учётом вложенности
function element(html: string, re: RegExp): string | undefined {
	const m = re.exec(html);
	if (!m) return undefined;
	const name = m[1].toLowerCase();
	const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
	tags.lastIndex = m.index + m[0].length;
	let depth = 1;
	for (let t = tags.exec(html); t; t = tags.exec(html)) {
		depth += t[1] ? -1 : 1;
		if (depth === 0) return html.slice(m.index + m[0].length, t.index);
	}
	return html.slice(m.index + m[0].length);
}

// Удалить все элементы, открывающий тег которых подходит под re (с вложенными тегами того же имени)
function removeElements(html: string, re: RegExp): string {
	const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
	let out = "";
	let pos = 0;
	for (let m = global.exec(html); m; m = global.exec(html)) {
		if (m.index < pos) continue;
		const name = m[1].toLowerCase();
		const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
		tags.lastIndex = m.index + m[0].length;
		let depth = 1;
		let end = html.length;
		for (let t = tags.exec(html); t; t = tags.exec(html)) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) {
				end = t.index + t[0].length;
				break;
			}
		}
		out += html.slice(pos, m.index);
		pos = end;
		global.lastIndex = end;
	}
	return out + html.slice(pos);
}

// Основной блок: от самых точных признаков к общим
const MAIN = [
	/<(div)\b[^>]*class="[^"]*\bmw-parser-output\b[^"]*"[^>]*>/i, // Википедия
	/<(article)\b[^>]*class="[^"]*\bmarkdown-body\b[^"]*"[^>]*>/i, // GitHub README
	/<(article)\b[^>]*class="[^"]*\bltx_document\b[^"]*"[^>]*>/i, // arXiv HTML
	/<(main)\b[^>]*>/i,
	/<(\w+)\b[^>]*role="main"[^>]*>/i,
	/<(article)\b[^>]*>/i,
	/<(\w+)\b[^>]*id="(?:content|main-content|main)"[^>]*>/i,
	/<(body)\b[^>]*>/i,
];

const DROP = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "header", "footer", "aside", "form", "button", "select", "dialog"];

function htmlToMarkdown(html: string, base: string): { title: string; text: string } {
	const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
	let body = html.replace(/<!--[\s\S]*?-->/g, "");
	for (const re of MAIN) {
		const found = element(body, re);
		if (found && found.replace(/<[^>]+>/g, "").trim().length > 200) {
			body = found;
			break;
		}
	}
	for (const tag of DROP) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), "");
	// Служебные блоки Википедии и типичные «редактировать», «навигация»
	body = removeElements(body, /<(\w+)\b[^>]*class="[^"]*\b(?:mw-editsection|mw-cite-backlink|navbox|metadata|sidebar|toc|noprint)\b[^"]*"[^>]*>/i);
	body = body.replace(/<img\b[^>]*class="[^"]*mwe-math-fallback[^"]*"[^>]*>/gi, "");

	// Формулы: у MathML (Википедия, arXiv) есть alttext с исходным LaTeX
	body = body.replace(/<math\b([^>]*)>[\s\S]*?<\/math>/gi, (_m, a: string) => {
		const tex = attr(` ${a}`, "alttext");
		const latex = tex?.replace(/\s+/g, " ").trim().replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim();
		return latex ? ` $${latex}$ ` : "";
	});
	// Код: защищаем от схлопывания пробелов
	const blocks: string[] = [];
	body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
		blocks.push(decode(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n+$/, ""));
		return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
	});
	body = body.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/<[^>]+>/g, "")}\``);

	// Таблицы: строка - через " | "
	body = body.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
		const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
		return `\n| ${cells.join(" | ")} |`;
	});

	body = body
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()}\n\n`)
		.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, a: string, inner: string) => {
			const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
			const href = attr(` ${a}`, "href");
			if (!text) return "";
			if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
			try {
				return `[${text}](${new URL(href, base).href})`;
			} catch {
				return text;
			}
		})
		.replace(/<img\b([^>]*)>/gi, (_m, a: string) => {
			const alt = attr(` ${a}`, "alt");
			return alt ? `[image: ${alt}]` : "";
		})
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(/<\/?(p|div|section|ul|ol|dl|dt|dd|blockquote|figure|figcaption|table|thead|tbody|caption|tr)\b[^>]*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");

	const text = decode(body)
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => "```\n" + blocks[Number(i)] + "\n```")
		.trim();
	return { title, text };
}

// --- web_fetch

const ARXIV_ABS = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/([^?#]+?)(?:\.pdf)?\/?(?:[?#].*)?$/i;

async function fetchDocument(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }> {
	// arXiv: HTML-версия лучше PDF - формулы как LaTeX, без переносов и колонтитулов
	const arxiv = url.match(ARXIV_ABS);
	if (arxiv && !/\/pdf\//i.test(url)) {
		const htmlUrl = `https://arxiv.org/html/${arxiv[1]}`;
		const { res, body } = await download(htmlUrl, signal);
		if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
			const doc = htmlToMarkdown(body.toString("utf8"), res.url);
			if (doc.text.length > 2000) return { url: res.url, ...doc };
		}
		url = `https://arxiv.org/pdf/${arxiv[1]}`;
	}

	const { res, body } = await download(url, signal);
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
	const type = (res.headers.get("content-type") ?? "").toLowerCase();
	if (type.includes("pdf") || body.subarray(0, 5).toString() === "%PDF-") {
		return { url: res.url, title: "", text: await pdfToText(body) };
	}
	const raw = body.toString("utf8");
	if (type.includes("html") || /^\s*<(!doctype html|html)/i.test(raw)) return { url: res.url, ...htmlToMarkdown(raw, res.url) };
	return { url: res.url, title: "", text: raw };
}

// --- web_search

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function clean(html: string): string {
	return decode(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// DuckDuckGo ограничивает частоту по IP и ставит капчу (HTTP 202) - тогда второй адрес, с паузой.
// Больше запросов не шлём: частые попытки только продлевают блокировку
const DDG = [
	{ url: (q: string) => `https://html.duckduckgo.com/html/?${new URLSearchParams({ q, kl: "wt-wt" })}` },
	{ url: () => "https://lite.duckduckgo.com/lite/", post: true },
];

function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
	const results: SearchResult[] = [];
	// html.duckduckgo.com: a.result__a + .result__snippet; lite: a.result-link + td.result-snippet
	const links = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\b(?:result__a|result-link)\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/g)];
	for (const [i, link] of links.entries()) {
		const tag = link[0].slice(0, link[0].indexOf(">") + 1);
		// Рекламные блоки ведут на duckduckgo.com/y.js
		let href = attr(tag, "href") ?? "";
		try {
			const u = new URL(href, "https://duckduckgo.com");
			href = u.searchParams.get("uddg") ?? u.href;
		} catch {}
		if (!href || /duckduckgo\.com\/y\.js/.test(href)) continue;
		const until = links[i + 1]?.index ?? html.length;
		const rest = html.slice(link.index! + link[0].length, until);
		const snippet = rest.match(/class=["'][^"']*\bresult[_-]+snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
		results.push({ title: clean(link[1]), url: href, snippet: snippet ? clean(snippet[1]) : "" });
		if (results.length >= limit) break;
	}
	return results;
}

async function duckduckgo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	let status = 0;
	for (const [i, variant] of DDG.entries()) {
		if (i > 0) await new Promise((r) => setTimeout(r, 1000));
		const { res, body } = await download(
			variant.url(query),
			signal,
			variant.post
				? {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
					}
				: {},
		);
		const html = body.toString("utf8");
		status = res.status;
		if (res.status !== 200 || /anomaly-modal|challenge-form/.test(html)) continue;
		return parseDuckDuckGo(html, limit);
	}
	throw new Error(`DuckDuckGo refused the request (HTTP ${status}: rate limiting or captcha)`);
}

// Запасной вариант без ключа: поиск по Википедии - только энциклопедические статьи
async function wikipedia(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const params = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(limit), format: "json", utf8: "1" });
	const { res, body } = await download(`https://en.wikipedia.org/w/api.php?${params}`, signal);
	if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
	return (JSON.parse(body.toString("utf8")).query?.search ?? []).map((r: { title: string; snippet: string }) => ({
		title: r.title,
		url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
		snippet: clean(r.snippet),
	}));
}

interface FetchDetails {
	url: string;
	fullOutputPath?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			`Fetch a URL and return its readable text: HTML is converted to markdown (main content only), PDF to plain text. ` +
			`arXiv abs/pdf links return the full paper (HTML version with LaTeX formulas when available). ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the full text is saved to a temp file whose path is given, read it with offset to continue.`,
		promptSnippet: "web_fetch: Fetch a web page or PDF as text",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL" }),
		}),

		async execute(_id, params, signal) {
			if (!/^https?:\/\//i.test(params.url)) throw new Error("Only http(s) URLs are supported");
			const doc = await fetchDocument(params.url, signal);
			if (!doc.text) return { content: [{ type: "text", text: `No readable text at ${doc.url}` }], details: { url: doc.url } as FetchDetails };
			const full = (doc.title ? `# ${doc.title}\n\n` : "") + `Source: ${doc.url}\n\n${doc.text}\n`;
			const truncation = truncateHead(full, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			if (!truncation.truncated) return { content: [{ type: "text", text: full }], details: { url: doc.url } as FetchDetails };
			const file = join(await mkdtemp(join(tmpdir(), "pi-web-")), "page.md");
			await writeFile(file, full, "utf8");
			return {
				content: [
					{
						type: "text",
						text: `${truncation.content}\n\n[Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full text: ${file}]`,
					},
				],
				details: { url: doc.url, fullOutputPath: file } as FetchDetails,
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web via DuckDuckGo's HTML page (no API key; it is scraping and may be rate-limited or break; then it falls back to Wikipedia search and says so). " +
			"Returns titles, URLs and snippets; open a result with web_fetch. For scientific literature prefer paper_search.",
		promptSnippet: "web_search: Search the web (DuckDuckGo)",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results, default 8" })),
		}),

		async execute(_id, params, signal) {
			const limit = Math.max(1, Math.min(params.limit ?? 8, 20));
			let results: SearchResult[];
			let note = "";
			try {
				results = await duckduckgo(params.query, limit, signal);
			} catch (err) {
				results = await wikipedia(params.query, limit, signal);
				note = `${(err as Error).message}. Showing Wikipedia results instead; retry web_search later, use paper_search for literature, or web_fetch a known URL.\n\n`;
			}
			if (!results.length) return { content: [{ type: "text", text: `${note}No results` }], details: { count: 0, fallback: Boolean(note) } };
			const text = note + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
			return { content: [{ type: "text", text }], details: { count: results.length, fallback: Boolean(note) } };
		},
	});
}
