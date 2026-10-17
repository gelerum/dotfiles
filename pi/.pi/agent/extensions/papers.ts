/**
 * paper_search: поиск статей без API-ключей - Semantic Scholar, OpenAlex, arXiv, Crossref.
 * Результаты объединяются по DOI, arXiv id и названию: у Semantic Scholar и OpenAlex -
 * цитирования и открытые PDF, у arXiv - свежие препринты, Crossref только дополняет.
 * Без ключа у всех общие лимиты: Semantic Scholar часто отвечает 429, arXiv - при частых
 * запросах, OpenAlex - около сотни поисков в день на IP. Отказавший источник пропускается с пометкой
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TIMEOUT_MS = 20_000;
const ABSTRACT_CHARS = 300;
const UA = "pi-paper-search/1.0 (personal research tool)";

interface Paper {
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	citations?: number;
	doi?: string;
	arxiv?: string;
	pdf?: string;
	url?: string;
	abstract?: string;
	sources: string[];
}

interface Range {
	from?: number;
	to?: number;
}

const inRange = (p: Paper, r: Range) => !p.year || ((!r.from || p.year >= r.from) && (!r.to || p.year <= r.to));

function decode(text: string): string {
	return text
		.replace(/<[^>]+>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

async function get(url: string, source: string, signal?: AbortSignal): Promise<Response> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		return await fetch(url, { headers: { "user-agent": UA }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	} catch (err) {
		if (timeout.aborted) throw new Error(`${source} did not answer in ${TIMEOUT_MS / 1000}s`);
		throw err;
	}
}

// Без ключа общие лимиты: пара повторов с паузой, потом источник пропускается
async function getRetry(url: string, source: string, signal?: AbortSignal): Promise<Response> {
	let res = await get(url, source, signal);
	for (const pause of [2000, 4000]) {
		if (res.status !== 429 && res.status !== 503) return res;
		await new Promise((r) => setTimeout(r, pause));
		res = await get(url, source, signal);
	}
	if (res.status === 429 || res.status === 503) throw new Error(`${source} rate limit (HTTP ${res.status}), skipped`);
	return res;
}

// --- arXiv (Atom)

async function arxiv(query: string, limit: number, range: Range, signal?: AbortSignal): Promise<Paper[]> {
	const terms = query.split(/\s+/).filter(Boolean).map((w) => `all:${w.replace(/[^\p{L}\p{N}-]/gu, "")}`).filter((t) => t !== "all:");
	let search = terms.join(" AND ");
	if (range.from || range.to) search += ` AND submittedDate:[${range.from ?? 1990}01010000 TO ${range.to ?? 2100}12312359]`;
	const url = `https://export.arxiv.org/api/query?${new URLSearchParams({ search_query: search, start: "0", max_results: String(limit), sortBy: "relevance" })}`;
	const res = await getRetry(url, "arXiv", signal);
	if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
	const xml = await res.text();
	return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
		const tag = (name: string) => e.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
		const id = (tag("id") ?? "").replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
		return {
			title: decode(tag("title") ?? ""),
			authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1])),
			year: Number((tag("published") ?? "").slice(0, 4)) || undefined,
			venue: tag("arxiv:journal_ref") ? decode(tag("arxiv:journal_ref")!) : undefined,
			doi: tag("arxiv:doi") ? decode(tag("arxiv:doi")!) : undefined,
			arxiv: id,
			pdf: `https://arxiv.org/pdf/${id}`,
			url: `https://arxiv.org/abs/${id}`,
			abstract: decode(tag("summary") ?? ""),
			sources: ["arxiv"],
		};
	});
}

// --- Semantic Scholar

async function semanticScholar(query: string, limit: number, range: Range, signal?: AbortSignal): Promise<Paper[]> {
	const params = new URLSearchParams({
		query,
		limit: String(limit),
		fields: "title,authors,year,venue,citationCount,externalIds,openAccessPdf,abstract,url",
	});
	if (range.from || range.to) params.set("year", `${range.from ?? ""}-${range.to ?? ""}`);
	const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
	const res = await getRetry(url, "Semantic Scholar", signal);
	if (!res.ok) throw new Error(`Semantic Scholar HTTP ${res.status}`);
	const data: any = await res.json();
	return (data.data ?? []).map((p: any) => ({
		title: p.title ?? "",
		authors: (p.authors ?? []).map((a: any) => a.name),
		year: p.year ?? undefined,
		venue: p.venue || undefined,
		citations: p.citationCount ?? undefined,
		doi: p.externalIds?.DOI,
		arxiv: p.externalIds?.ArXiv,
		pdf: p.openAccessPdf?.url || (p.externalIds?.ArXiv ? `https://arxiv.org/pdf/${p.externalIds.ArXiv}` : undefined),
		url: p.url,
		abstract: p.abstract ?? undefined,
		sources: ["semantic_scholar"],
	}));
}

// --- OpenAlex

async function openalex(query: string, limit: number, range: Range, signal?: AbortSignal): Promise<Paper[]> {
	const params = new URLSearchParams({
		search: query,
		"per-page": String(limit),
		select: "doi,display_name,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index,best_oa_location",
	});
	const filter = [range.from && `from_publication_date:${range.from}-01-01`, range.to && `to_publication_date:${range.to}-12-31`].filter(Boolean).join(",");
	if (filter) params.set("filter", filter);
	const res = await getRetry(`https://api.openalex.org/works?${params}`, "OpenAlex", signal);
	if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
	const data: any = await res.json();
	return (data.results ?? []).map((w: any) => {
		const doi = w.doi?.replace(/^https?:\/\/doi\.org\//, "");
		const pdf: string | undefined = w.best_oa_location?.pdf_url ?? undefined;
		// Аннотация хранится как инвертированный индекс: слово -> позиции
		const words: string[] = [];
		for (const [word, positions] of Object.entries(w.abstract_inverted_index ?? {})) for (const i of positions as number[]) words[i] = word;
		const arxiv = doi?.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1] ?? pdf?.match(/arxiv\.org\/pdf\/([^v?#]+(?:v\d+)?)/)?.[1]?.replace(/v\d+$/, "");
		return {
			title: w.display_name ?? "",
			authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
			year: w.publication_year ?? undefined,
			venue: w.primary_location?.source?.display_name ?? undefined,
			citations: w.cited_by_count ?? undefined,
			doi: arxiv && doi?.toLowerCase().startsWith("10.48550/") ? undefined : doi,
			arxiv,
			pdf,
			url: w.doi ?? undefined,
			abstract: words.length ? words.filter(Boolean).join(" ") : undefined,
			sources: ["openalex"],
		};
	});
}

// --- Crossref

async function crossref(query: string, limit: number, range: Range, signal?: AbortSignal): Promise<Paper[]> {
	const params = new URLSearchParams({
		"query.bibliographic": query,
		rows: String(limit),
		select: "DOI,title,author,issued,container-title,is-referenced-by-count,abstract,link,type",
	});
	// Только сами работы: без приложений (component), рецензий (peer-review), датасетов
	const types = ["journal-article", "proceedings-article", "posted-content", "book-chapter", "book", "monograph", "dissertation", "report"];
	const filter = [...types.map((t) => `type:${t}`), range.from && `from-pub-date:${range.from}`, range.to && `until-pub-date:${range.to}`];
	params.set("filter", filter.filter(Boolean).join(","));
	const res = await getRetry(`https://api.crossref.org/works?${params}`, "Crossref", signal);
	if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
	const data: any = await res.json();
	return (data.message?.items ?? [])
		.filter((w: any) => w.title?.[0])
		.map((w: any) => ({
			title: decode(w.title[0]),
			authors: (w.author ?? []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")),
			year: w.issued?.["date-parts"]?.[0]?.[0] ?? undefined,
			venue: w["container-title"]?.[0],
			citations: w["is-referenced-by-count"],
			doi: w.DOI,
			pdf: (w.link ?? []).find((l: any) => l["content-type"] === "application/pdf")?.URL,
			url: w.DOI ? `https://doi.org/${w.DOI}` : undefined,
			abstract: w.abstract ? decode(w.abstract).replace(/^Abstract\s*/i, "") : undefined,
			sources: ["crossref"],
		}));
}

// --- объединение

const norm = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// primary - вперемешку, чтобы ни один источник не вытеснил другой; secondary - в конец
function merge(primary: Paper[][], secondary: Paper[][] = []): Paper[] {
	const out: Paper[] = [];
	const find = (p: Paper) =>
		out.find(
			(q) =>
				(p.doi && q.doi && p.doi.toLowerCase() === q.doi.toLowerCase()) ||
				(p.arxiv && q.arxiv && p.arxiv === q.arxiv) ||
				norm(p.title) === norm(q.title),
		);
	const add = (p: Paper) => {
		const q = find(p);
		if (!q) {
			out.push({ ...p, sources: [...p.sources] });
			return;
		}
		for (const k of ["year", "venue", "citations", "doi", "arxiv", "pdf", "url", "abstract"] as const) {
			if (q[k] === undefined && p[k] !== undefined) (q as any)[k] = p[k];
		}
		if (p.citations !== undefined && (q.citations ?? -1) < p.citations) q.citations = p.citations;
		if (p.authors.length > q.authors.length) q.authors = p.authors;
		if ((p.abstract?.length ?? 0) > (q.abstract?.length ?? 0)) q.abstract = p.abstract;
		q.sources.push(...p.sources);
	};
	for (let i = 0; i < Math.max(0, ...primary.map((l) => l.length)); i++) for (const list of primary) if (list[i]) add(list[i]);
	for (const list of secondary) list.forEach(add);
	return out;
}

function show(p: Paper, i: number): string {
	const authors = p.authors.length > 3 ? `${p.authors.slice(0, 3).join(", ")} et al.` : p.authors.join(", ");
	const meta = [p.year, p.venue, p.citations !== undefined ? `${p.citations} citations` : undefined].filter(Boolean).join(" · ");
	const ids = [p.doi && `doi:${p.doi}`, p.arxiv && `arXiv:${p.arxiv}`].filter(Boolean).join("  ");
	const abs = p.abstract ? (p.abstract.length > ABSTRACT_CHARS ? `${p.abstract.slice(0, ABSTRACT_CHARS)}…` : p.abstract) : "";
	return [
		`${i + 1}. ${p.title}`,
		`   ${authors}${meta ? ` — ${meta}` : ""}`,
		ids && `   ${ids}`,
		(p.pdf || p.url) && `   ${p.pdf ? `PDF: ${p.pdf}` : p.url}`,
		abs && `   ${abs}`,
	]
		.filter(Boolean)
		.join("\n");
}

const SOURCES = { semantic_scholar: semanticScholar, openalex, arxiv, crossref };

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "paper_search",
		label: "Paper search",
		description:
			"Search scientific papers in Semantic Scholar, OpenAlex, arXiv and Crossref (no API keys). Returns deduplicated papers with authors, year, venue, " +
			"citation count, DOI/arXiv id, PDF link and an abstract snippet. Read a paper with web_fetch on its arXiv or PDF link. " +
			"Keyless access is rate-limited: a source that refuses is skipped and listed as unavailable; don't retry in a tight loop.",
		promptSnippet: "paper_search: Search scientific papers (Semantic Scholar, OpenAlex, arXiv, Crossref)",
		parameters: Type.Object({
			query: Type.String({ description: "Search query, e.g. key terms of the topic" }),
			limit: Type.Optional(Type.Number({ description: "Max papers, default 10" })),
			source: Type.Optional(
				Type.Union([Type.Literal("all"), Type.Literal("semantic_scholar"), Type.Literal("openalex"), Type.Literal("arxiv"), Type.Literal("crossref")], {
					description: "Default all",
				}),
			),
			year_from: Type.Optional(Type.Number({ description: "Earliest publication year" })),
			year_to: Type.Optional(Type.Number({ description: "Latest publication year" })),
		}),

		async execute(_id, params, signal) {
			const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
			const range = { from: params.year_from, to: params.year_to };
			const names = (params.source ?? "all") === "all" ? (Object.keys(SOURCES) as (keyof typeof SOURCES)[]) : [params.source as keyof typeof SOURCES];
			const settled = await Promise.allSettled(names.map((n) => SOURCES[n](params.query, limit, range, signal)));
			const notes = settled.flatMap((s, i) => (s.status === "rejected" ? [`${names[i]}: ${s.reason?.message ?? s.reason}`] : []));
			const found = settled.map((s) => (s.status === "fulfilled" ? s.value.filter((p) => p.title && inRange(p, range)) : []));
			// Crossref ищет хуже (много нерелевантного) - только дополняет остальные источники
			const papers = merge(
				found.filter((_, i) => names[i] !== "crossref"),
				found.filter((_, i) => names[i] === "crossref"),
			).slice(0, limit);
			const text =
				(papers.length ? papers.map(show).join("\n\n") : "No papers found") + (notes.length ? `\n\n(Unavailable: ${notes.join("; ")})` : "");
			return { content: [{ type: "text", text }], details: { count: papers.length, unavailable: notes } };
		},
	});
}
