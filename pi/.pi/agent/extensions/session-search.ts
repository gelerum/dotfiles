/**
 * Поиск по прошлым сессиям pi: ~/.pi/agent/sessions/--<путь>--/*.jsonl (смонтирована с хоста).
 * rg находит строки-кандидаты, дальше смотрим только реплики пользователя и ассистента:
 * без системного промпта (он сохраняется в каждой сессии), инструментов и их результатов
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);
const SNIPPET = 160;

// Корень основного репозитория: так в поиск попадают и подпапки, и worktree проекта
function projectRoot(cwd: string): string {
	try {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return path.basename(common) === ".git" ? path.dirname(common) : cwd;
	} catch {
		return cwd;
	}
}

// Имя папки сессий как у pi: без ведущего "/", а "/", "\" и ":" -> "-"
function sessionKey(dir: string): string {
	return "--" + dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

function texts(entry: any): string[] {
	const role = entry.message?.role;
	if (entry.type !== "message" || (role !== "user" && role !== "assistant")) return [];
	const content = entry.message.content;
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text);
}

function snippet(text: string, re: RegExp): string | undefined {
	const m = re.exec(text);
	if (!m) return undefined;
	const start = Math.max(0, m.index - SNIPPET);
	const end = Math.min(text.length, m.index + m[0].length + SNIPPET);
	return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

interface Hit {
	time: string;
	role: string;
	file: string;
	text: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_search",
		label: "Session search",
		description:
			"Search past pi sessions (user and assistant messages) by regex, case-insensitive. " +
			"Use it to recall how something was discussed or decided before. Returns newest matches first with the session path; " +
			"session files are large JSONL, so search inside one with bash rg instead of reading it whole.",
		promptSnippet: "session_search: Search past pi sessions",
		parameters: Type.Object({
			query: Type.String({ description: "Regex (ripgrep syntax), case-insensitive" }),
			all_projects: Type.Optional(Type.Boolean({ description: "Search every project, not only the current one. Default false" })),
			limit: Type.Optional(Type.Number({ description: "Max matches to return. Default 20" })),
		}),

		async execute(_id, params, signal, _onUpdate, ctx) {
			const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
			// getSessionDir() - папка текущего проекта, все сессии - уровнем выше
			const current = ctx.sessionManager.getSessionDir();
			const root = path.basename(current).startsWith("--") ? path.dirname(current) : current;
			const key = sessionKey(projectRoot(ctx.cwd));
			let dirs: string[];
			try {
				dirs = fs
					.readdirSync(root)
					.filter((d) => params.all_projects || d.startsWith(key))
					.map((d) => path.join(root, d));
			} catch {
				dirs = [];
			}
			if (dirs.length === 0) return { content: [{ type: "text", text: `No sessions in ${root}` }], details: { matches: 0 } };

			let out = "";
			try {
				// --null: имя файла отделено \0, двоеточия в JSON не мешают
				({ stdout: out } = await run(
					"rg",
					["-i", "--null", "--no-line-number", "--max-depth", "1", "--glob", "*.jsonl", "-e", params.query, ...dirs],
					{ maxBuffer: 512 * 1024 * 1024, signal },
				));
			} catch (err: any) {
				if (err.code !== 1) throw new Error(`rg failed: ${err.stderr || err.message}`);
			}

			// Текущая сессия не нужна: в ней совпадёт сам запрос
			const self = ctx.sessionManager.getSessionFile();
			const re = new RegExp(params.query, "i");
			const hits: Hit[] = [];
			for (const line of out.split("\n")) {
				const sep = line.indexOf("\0");
				if (sep < 0) continue;
				const file = line.slice(0, sep);
				if (file === self) continue;
				let entry: any;
				try {
					entry = JSON.parse(line.slice(sep + 1));
				} catch {
					continue;
				}
				for (const t of texts(entry)) {
					const s = snippet(t, re);
					if (s) hits.push({ time: entry.timestamp ?? "", role: entry.message.role, file, text: s });
				}
			}
			if (hits.length === 0) return { content: [{ type: "text", text: "No matches" }], details: { matches: 0 } };

			hits.sort((a, b) => b.time.localeCompare(a.time));
			const shown = hits.slice(0, limit);
			const text =
				shown.map((h) => `${h.time.slice(0, 16).replace("T", " ")} ${h.role} ${h.file}\n  ${h.text}`).join("\n\n") +
				(hits.length > limit ? `\n\n(${hits.length - limit} more matches; narrow the query or raise limit)` : "");
			return { content: [{ type: "text", text }], details: { matches: hits.length } };
		},
	});
}
