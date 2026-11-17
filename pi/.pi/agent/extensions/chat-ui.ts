/** Compact transcript rendering and quote replies. Never changes model-facing results. */
import type {
	ExtensionAPI, ExtensionContext, ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";
import * as os from "node:os";

const PREFERENCE_ENTRY = "chat-ui-preferences";
const MAX_QUOTE_CHARS = 20_000;
const INTERACTIVE_TOOLS = new Set(["todo", "questionnaire"]);

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = { content: { type: string; text?: string }[]; details?: unknown };
type Row = { result?: Result; summary?: string; warning?: string; upstream: Record<string, unknown>; call?: unknown; output?: unknown; invalidate?: () => void };
type SelectionHost = {
	// Compatibility bridge: private in pi 1.5.0/1.5.2, not part of ExtensionUIContext.
	// Feature-detect only this method; never inspect selection coordinates or read
	// the OS clipboard. If upstream removes it, use the explicit excerpt picker.
	getActiveSelectionText?: () => string | undefined;
	resetTextSelection?: () => void;
};

export function oneLine(text: string, limit = 100): string {
	return truncateToWidth(stripTerminalSequences(text).replace(/[\r\n\t]+/g, " "), limit, "…");
}

export function quotedDraft(text: string, draft: string): string {
	const clean = stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
	const quote = clean.split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
	return `${quote}\n\n${draft}`;
}

export function selectionText(host: SelectionHost | undefined): string | undefined {
	try {
		const text = host?.getActiveSelectionText?.();
		return typeof text === "string" && text.trim() ? text : undefined;
	} catch {
		return undefined;
	}
}

export function assistantReplies(entries: readonly any[]): string[] {
	return entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
		.map((entry) => {
			const content = entry.message.content;
			return typeof content === "string" ? content : Array.isArray(content)
				? content.filter((block: any) => block.type === "text" && typeof block.text === "string")
					.map((block: any) => block.text).join("\n") : "";
		}).filter((text) => text.trim()).reverse().slice(0, 20);
}

function resultText(result: Result | undefined): string {
	return result?.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") ?? "";
}

function lintFindings(result: Result | undefined): string | undefined {
	const text = resultText(result);
	const start = text.indexOf("Lint errors in this file, fix them:");
	return start < 0 ? undefined : text.slice(start).split("\n").slice(1).filter(Boolean).join("\n");
}

function shortPath(value: unknown, cwd: string): string {
	if (typeof value !== "string") return "";
	const relative = path.isAbsolute(value) ? path.relative(cwd, value) : value;
	if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)) return oneLine(relative);
	const home = os.homedir();
	return oneLine(value.startsWith(home + path.sep) ? "~" + value.slice(home.length) : value);
}

export function toolTitle(name: string, args: Record<string, unknown>, cwd: string): string {
	const file = shortPath(args.path ?? args.relative_path, cwd);
	const labels: Record<string, string> = {
		read: "Read", write: "Write", edit: "Edit", bash: "Shell", powershell: "Shell",
		find: "Find", grep: "Search", ls: "List", notebook_read: "Read notebook",
		notebook_edit: "Edit notebook", notebook_run: "Run notebook", subagent: "Subagent",
	};
	// Do not dump commands, prompts, URLs, queries or JSON arguments into collapsed
	// headers. Full arguments are still available in the expanded renderer.
	const label = labels[name] ?? name.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " ");
	return file ? `${label} · ${file}` : label;
}

function summary(name: string, row: Row): string {
	if (!row.result) return "";
	if (row.warning) return "Lint findings";
	const details = row.result.details as { truncation?: { truncated?: boolean }; diff?: string } | undefined;
	if (details?.truncation?.truncated) return "Output truncated";
	if (row.result.content.some((block) => block.type === "image")) return "Image";
	if (name === "edit" && details?.diff) {
		const lines = details.diff.split("\n");
		return `+${lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} / −${lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}`;
	}
	const text = resultText(row.result);
	const count = text ? text.split("\n").filter((line) => line.trim()).length : 0;
	return count ? `${count} ${count === 1 ? "line" : "lines"}` : "";
}

export default function (pi: ExtensionAPI) {
	let compact = true;
	let selectionHost: SelectionHost | undefined;
	let quoting = false;
	// Removed /tree branches must not be retained through renderer callbacks.
	const redraw = new Map<string, WeakRef<Row>>();

	pi.registerToolRenderer((name, next) => {
		const original = next();
		if (INTERACTIVE_TOOLS.has(name)) return original;
		function rowFor(ctx: ToolRenderContext): Row {
			const row: Row = ctx.state.chatUI ??= { upstream: {} };
			row.invalidate = ctx.invalidate;
			redraw.set(ctx.toolCallId, new WeakRef(row));
			return row;
		}
		function delegate(slot: "call" | "output", ctx: ToolRenderContext, row: Row) {
			return { ...ctx, state: row.upstream, lastComponent: row[slot] } as ToolRenderContext;
		}
		const renderers: ToolRenderers = {
			renderShell: "self",
			renderCall(args, theme, ctx) {
				const row = rowFor(ctx);
				if (!compact || ctx.expanded) {
					row.call = original?.renderCall?.(args, theme, delegate("call", ctx, row))
						?? new Text(`${name}\n${JSON.stringify(args, null, 2)}`, 0, 0);
					return row.call as ReturnType<NonNullable<ToolRenderers["renderCall"]>>;
				}
				return {
					invalidate() {},
					render(width: number) {
						const warning = Boolean(row.warning);
						const symbol = ctx.isPartial ? "…" : ctx.isError ? "✗" : warning ? "!" : "✓";
						const color = ctx.isError ? "error" : ctx.isPartial || warning ? "warning" : "success";
						const detail = row.summary ?? "";
						const duration = ctx.durationMs === undefined ? "" : ` · ${(ctx.durationMs / 1000).toFixed(1)}s`;
						const line = `${theme.fg(color, symbol)} ${toolTitle(name, args && typeof args === "object" ? args as Record<string, unknown> : {}, ctx.cwd)}${detail ? ` · ${detail}` : ""}${duration}`;
						return [truncateToWidth(line, width, "…")];
					},
				};
			},
			renderResult(result, options, theme, ctx) {
				const row = rowFor(ctx);
				row.result = result;
				row.warning = lintFindings(result);
				row.summary = summary(name, row);
				if (!compact || options.expanded) {
					row.output = original?.renderResult?.(result, options, theme, delegate("output", ctx, row))
						?? new Text(resultText(result), 0, 0);
					const output = row.output as ReturnType<NonNullable<ToolRenderers["renderResult"]>>;
					// Built-in edit/write renderers omit successful text content, so
					// delegation alone would hide diagnostics appended by lint.ts.
					// Keep their component/state intact and append ALL findings.
					if (row.warning && original?.renderResult) {
						const combined = new Container();
						combined.addChild(output);
						combined.addChild(new Text(theme.fg("warning", `Lint findings\n${row.warning}`), 0, 0));
						return combined;
					}
					return output;
				}
				const warning = row.warning;
				const preview = ctx.isError ? resultText(result) : warning;
				// Keep errors and lint findings visible, but bound their collapsed
				// preview. No tool_result hook: model/session data stays untouched.
				return {
					invalidate() {},
					render(width: number) {
						if (!preview) return [];
						const lines = stripTerminalSequences(preview).split("\n").filter((line) => line.trim());
						return [...lines.slice(0, 3).map((line) => truncateToWidth(theme.fg(ctx.isError ? "error" : "warning", line), width, "…")),
							truncateToWidth(theme.fg("dim", ctx.keyHint("app.tools.expand", "for details")), width, "…")];
					},
				};
			},
		};
		return renderers;
	});

	pi.on("session_start", (_event, ctx) => {
		redraw.clear();
		selectionHost = undefined;
		quoting = false;
		compact = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PREFERENCE_ENTRY
				&& typeof (entry.data as any)?.compact === "boolean") compact = (entry.data as any).compact;
		}
		if (ctx.mode !== "tui") return;
		ctx.ui.setToolsExpanded(!compact);
		// An invisible widget supplies the real renderer without replacing the
		// user's editor/header/footer. No clipboard or host display access needed.
		ctx.ui.setWidget("chat-ui-selection", (tui) => {
			selectionHost = tui as unknown as SelectionHost;
			return { render: () => [], invalidate() {}, dispose() { selectionHost = undefined; } };
		});
	});
	pi.on("session_shutdown", () => { selectionHost = undefined; redraw.clear(); });

	pi.registerCommand("ui", {
		description: "Tool output: /ui compact or /ui verbose (Ctrl+O expands details)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const mode = args.trim().toLowerCase();
			if (mode !== "compact" && mode !== "verbose") {
				ctx.ui.notify(`Tool output: ${compact ? "compact" : "verbose"}. Use /ui compact or /ui verbose.`, "info");
				return;
			}
			compact = mode === "compact";
			pi.appendEntry(PREFERENCE_ENTRY, { compact });
			ctx.ui.setToolsExpanded(!compact);
			for (const [id, reference] of [...redraw]) {
				const row = reference.deref();
				if (row) row.invalidate?.();
				else redraw.delete(id);
			}
		},
	});

	async function quote(args: string, ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || quoting) return;
		quoting = true;
		try {
			// A rendered mouse selection may have lost Markdown/LaTeX delimiters.
			// --pick explicitly selects an excerpt from the saved message source.
			let text = args.trim() === "--pick" ? undefined : args.trim() || selectionText(selectionHost);
			if (!text) {
				const replies = assistantReplies(ctx.sessionManager.getBranch());
				if (!replies.length) {
					ctx.ui.notify("No assistant replies to quote yet.", "info");
					return;
				}
				const labels = replies.map((reply, index) => `${index + 1}. ${oneLine(reply, 85)}`);
				const choice = await ctx.ui.select("Quote an assistant reply", labels);
				if (choice === undefined) return;
				const reply = replies[labels.indexOf(choice)];
				if (reply === undefined) return;
				text = await ctx.ui.editor("Keep the excerpt you want to quote; cancel to leave the draft unchanged", reply);
				if (!text?.trim()) return;
				if (!reply.replace(/\r\n?/g, "\n").includes(text.replace(/\r\n?/g, "\n").trim())) {
					ctx.ui.notify("Keep an unchanged, contiguous excerpt from the reply.", "warning");
					return;
				}
			}
			if (text.length > MAX_QUOTE_CHARS) {
				ctx.ui.notify("Selection is too large. Quote a shorter excerpt (maximum 20,000 characters).", "warning");
				return;
			}
			ctx.ui.setEditorText(quotedDraft(text, ctx.ui.getEditorText()));
			try { selectionHost?.resetTextSelection?.(); } catch { /* Quote is already inserted; cleanup is best-effort. */ }
		} finally {
			quoting = false;
		}
	}
	pi.registerShortcut("alt+q", { description: "Quote selected text, or pick an assistant reply", handler: (ctx) => quote("", ctx) });
	pi.registerCommand("quote", { description: "Quote selected text; /quote --pick chooses source text; /quote <text> inserts a manual quote", handler: quote });
}
