/**
 * Субагенты: задача уходит отдельному процессу `pi --mode json -p` со своим контекстом,
 * обратно приходит только итоговый ответ. По мотивам examples/extensions/subagent.
 *
 * - режимы: один агент (agent + task), параллельно (tasks), цепочка (chain, {previous} - вывод
 *   предыдущего шага)
 * - агенты - markdown с frontmatter (name, description, model, tools, thinking) в
 *   ~/.pi/agent/agents/ и, если проект доверенный, в .pi/agents/ проекта (перекрывают по имени)
 * - модель и уровень thinking по умолчанию - как у родителя
 * - в дочерних процессах PI_SUBAGENT=1 (инструмент subagent не регистрируется, без рекурсии)
 *   и PI_MEMORY_REFLECT=0 (без рефлексии памяти при выходе). Память в промпт ребёнку
 *   попадает - это только чтение индекса; линтер срабатывает лишь на write/edit
 * - живой лог: вызовы инструментов субагента с аргументами и началом результата, его реплики;
 *   свёрнуто - последние строки, ctrl+o - весь лог и ответ
 * - сессии субагентов сохраняются в ~/.pi/agent/subagents/<id сессии родителя>/ (не мешают
 *   /resume), старше KEEP_DAYS удаляются. /subagents - открыть сессию субагента в этом окне
 *   (можно продолжить с ним разговор), оттуда /subagents - назад к родителю
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;
const LOG_KEEP = 200; // записей лога на агента в details
const SNIPPET = 300; // символов результата инструмента или реплики в логе
const COLLAPSED_LINES = 4; // строк лога на агента в свёрнутом виде
const KEEP_DAYS = 30;

interface Agent {
	name: string;
	description: string;
	model?: string;
	tools?: string[];
	thinking?: string;
	prompt: string;
	source: "user" | "project";
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	costParts?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

type LogEntry =
	| { type: "tool"; id: string; name: string; args: string; state: "running" | "ok" | "error"; result?: string }
	| { type: "text"; text: string };

interface Result {
	agent: string;
	task: string;
	model?: string;
	output: string;
	ok: boolean;
	status: "queued" | "running" | "done" | "failed";
	error?: string;
	usage: Usage;
	log: LogEntry[];
	sessionFile?: string;
}

interface Details {
	mode?: "single" | "parallel" | "chain";
	results?: Result[];
}

// --- агенты

function loadAgents(dir: string, source: Agent["source"]): Agent[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	const agents: Agent[] = [];
	for (const file of files) {
		let fm: Record<string, unknown>;
		let body: string;
		try {
			({ frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(path.join(dir, file), "utf8")));
		} catch {
			continue;
		}
		if (typeof fm.name !== "string" || typeof fm.description !== "string") continue;
		// tools: "read, bash" или [read, bash]
		const raw = Array.isArray(fm.tools) ? fm.tools : typeof fm.tools === "string" ? fm.tools.split(",") : [];
		const tools = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
		agents.push({
			name: fm.name,
			description: fm.description,
			model: typeof fm.model === "string" ? fm.model : undefined,
			tools: tools.length ? tools : undefined,
			thinking: typeof fm.thinking === "string" ? fm.thinking : undefined,
			prompt: body.trim(),
			source,
		});
	}
	return agents;
}

function discoverAgents(cwd: string, projectTrusted: boolean): Agent[] {
	const byName = new Map<string, Agent>();
	for (const a of loadAgents(path.join(getAgentDir(), "agents"), "user")) byName.set(a.name, a);
	if (projectTrusted) {
		// Ближайшая .pi/agents вверх по дереву
		for (let dir = cwd; ; dir = path.dirname(dir)) {
			const candidate = path.join(dir, ".pi", "agents");
			if (fs.existsSync(candidate)) {
				for (const a of loadAgents(candidate, "project")) byName.set(a.name, a);
				break;
			}
			if (path.dirname(dir) === dir) break;
		}
	}
	return [...byName.values()];
}

// --- сессии субагентов

const subagentsRoot = () => path.join(getAgentDir(), "subagents");

interface IndexEntry {
	file: string;
	agent: string;
	task: string;
	time: number;
	ok: boolean;
	parent: string;
}

function readIndex(dir: string): IndexEntry[] {
	try {
		return fs
			.readFileSync(path.join(dir, "index.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as IndexEntry)
			.filter((e) => fs.existsSync(e.file));
	} catch {
		return [];
	}
}

function prune(): void {
	const root = subagentsRoot();
	const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
	let dirs: string[];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const d of dirs) {
		const full = path.join(root, d);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
		} catch {}
	}
}

function ago(ms: number): string {
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

// --- запуск одного агента

// pi собран в один бинарник Bun: process.execPath и есть pi. Под node/bun - скрипт из argv[1]
function piCommand(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	if (!/^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))) return { command: process.execPath, args };
	return { command: "pi", args };
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function cap(text: string): string {
	if (Buffer.byteLength(text) <= OUTPUT_CAP) return text;
	let cut = text.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(cut) > OUTPUT_CAP) cut = cut.slice(0, -1);
	return `${cut}\n\n[output truncated]`;
}

const oneLine = (s: string, max: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Главный аргумент вызова: команда, путь, запрос; иначе JSON
function argSummary(args: any): string {
	if (!args || typeof args !== "object") return "";
	for (const k of ["command", "path", "pattern", "query", "url", "agent"]) if (typeof args[k] === "string") return oneLine(args[k], 160);
	return oneLine(JSON.stringify(args), 160);
}

function resultSnippet(result: any): string {
	const text = (result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	return text.trim().slice(0, SNIPPET);
}

function newResult(agent: string, task: string): Result {
	return { agent, task, output: "", ok: false, status: "queued", usage: emptyUsage(), log: [] };
}

interface Defaults {
	cwd: string;
	model?: string;
	thinking?: string;
	sessionDir?: string; // undefined - родитель без сессии, ребёнок тоже
	parentSession?: string;
}

async function runAgent(
	agents: Agent[],
	result: Result,
	defaults: Defaults,
	signal: AbortSignal | undefined,
	changed: () => void,
): Promise<Result> {
	const { agent: name, task } = result;
	result.status = "running";
	changed();
	const agent = agents.find((a) => a.name === name);
	if (!agent) {
		result.error = `Unknown agent "${name}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`;
		result.status = "failed";
		return result;
	}

	const args = ["--mode", "json", "-p"];
	const sessionId = `${Date.now().toString(36)}-${name.replace(/[^A-Za-z0-9]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
	if (defaults.sessionDir) {
		fs.mkdirSync(defaults.sessionDir, { recursive: true });
		args.push("--session-dir", defaults.sessionDir, "--session-id", sessionId, "--name", `${name}: ${oneLine(task, 60)}`);
	} else args.push("--no-session");
	result.model = agent.model ?? defaults.model;
	if (result.model) args.push("--model", result.model);
	const thinking = agent.thinking ?? (agent.model ? undefined : defaults.thinking);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools) args.push("--tools", agent.tools.join(","));

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	try {
		if (agent.prompt) {
			const promptFile = path.join(tmp, "prompt.md");
			fs.writeFileSync(promptFile, agent.prompt, { mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${task}`);

		const push = (entry: LogEntry) => {
			result.log.push(entry);
			if (result.log.length > LOG_KEEP) result.log.splice(0, result.log.length - LOG_KEEP);
		};

		let stderr = "";
		let lastText = "";
		let stopReason: string | undefined;
		let aborted = false;
		const code = await new Promise<number>((resolve) => {
			const inv = piCommand(args);
			const proc = spawn(inv.command, inv.args, {
				cwd: defaults.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT: "1", PI_MEMORY_REFLECT: "0" },
			});
			let buffer = "";
			const onLine = (line: string) => {
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "tool_execution_start" && !event.parentToolCallId) {
					push({ type: "tool", id: event.toolCallId, name: event.toolName, args: argSummary(event.args), state: "running" });
					changed();
				} else if (event.type === "tool_execution_end" && !event.parentToolCallId) {
					const entry = result.log.find((e) => e.type === "tool" && e.id === event.toolCallId);
					if (entry?.type === "tool") {
						entry.state = event.isError ? "error" : "ok";
						entry.result = resultSnippet(event.result);
					}
					changed();
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					const msg = event.message;
					const u = msg.usage ?? {};
					result.usage.turns++;
					result.usage.input += u.input ?? 0;
					result.usage.output += u.output ?? 0;
					result.usage.cacheRead += u.cacheRead ?? 0;
					result.usage.cacheWrite += u.cacheWrite ?? 0;
					result.usage.cost += u.cost?.total ?? 0;
					const parts = (result.usage.costParts ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
					for (const k of Object.keys(parts) as (keyof typeof parts)[]) parts[k] += u.cost?.[k] ?? 0;
					if (msg.stopReason) stopReason = msg.stopReason;
					if (msg.errorMessage) result.error = msg.errorMessage;
					const text = (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
					if (text) {
						lastText = text;
						push({ type: "text", text: text.trim().slice(0, SNIPPET) });
					}
					changed();
				}
			};
			proc.stdout.on("data", (d) => {
				buffer += d.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const l of lines) if (l.trim()) onLine(l);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			proc.on("close", (c) => {
				if (buffer.trim()) onLine(buffer);
				resolve(c ?? 0);
			});
			proc.on("error", (err) => {
				stderr += String(err);
				resolve(1);
			});
			const kill = () => {
				aborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 5000);
			};
			if (signal?.aborted) kill();
			else signal?.addEventListener("abort", kill, { once: true });
		});

		result.output = lastText;
		result.ok = code === 0 && !aborted && stopReason !== "error" && stopReason !== "aborted";
		if (!result.ok && !result.error) result.error = aborted ? "aborted" : stderr.trim().slice(-2000) || `exit code ${code}`;
		result.status = result.ok ? "done" : "failed";
		for (const e of result.log) if (e.type === "tool" && e.state === "running") e.state = "error";

		if (defaults.sessionDir) {
			const file = fs.readdirSync(defaults.sessionDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
			if (file) {
				result.sessionFile = path.join(defaults.sessionDir, file);
				const entry: IndexEntry = { file: result.sessionFile, agent: name, task, time: Date.now(), ok: result.ok, parent: defaults.parentSession ?? "" };
				fs.appendFileSync(path.join(defaults.sessionDir, "index.jsonl"), `${JSON.stringify(entry)}\n`);
			}
		}
		return result;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

function usageLine(results: Result[]): string {
	const u = results.reduce((s, r) => {
		for (const k of Object.keys(s) as (keyof Usage)[]) s[k] += r.usage[k];
		return s;
	}, emptyUsage());
	return `${u.turns} turns, ↑${u.input} ↓${u.output} R${u.cacheRead} W${u.cacheWrite} tokens${u.cost ? `, $${u.cost.toFixed(4)}` : ""}`;
}

// usage результата инструмента: pi добавляет его к итогам сессии (футер, /session)
function toolUsage(results: Result[]) {
	const sum = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0);
	const input = sum((r) => r.usage.input);
	const output = sum((r) => r.usage.output);
	const cacheRead = sum((r) => r.usage.cacheRead);
	const cacheWrite = sum((r) => r.usage.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: sum((r) => r.usage.costParts?.input ?? 0),
			output: sum((r) => r.usage.costParts?.output ?? 0),
			cacheRead: sum((r) => r.usage.costParts?.cacheRead ?? 0),
			cacheWrite: sum((r) => r.usage.costParts?.cacheWrite ?? 0),
			total: sum((r) => r.usage.cost),
		},
	};
}

function render(r: Result): string {
	return r.ok ? cap(r.output || "(no output)") : `FAILED: ${r.error}${r.output ? `\n\n${cap(r.output)}` : ""}`;
}

// --- отображение в TUI

function logLine(e: LogEntry, theme: any, expanded: boolean): string[] {
	if (e.type === "text") {
		const text = expanded ? e.text : oneLine(e.text, 120);
		return text.split("\n").map((l, i) => `  ${i ? "  " : theme.fg("muted", "» ")}${theme.fg("muted", l)}`);
	}
	const mark = e.state === "running" ? theme.fg("warning", "…") : e.state === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const lines = [`  ${mark} ${theme.fg("accent", e.name)} ${theme.fg("dim", e.args)}`];
	if (expanded && e.result) for (const l of e.result.split("\n").slice(0, 6)) lines.push(`      ${theme.fg("dim", oneLine(l, 140))}`);
	return lines;
}

function renderAgent(r: Result, theme: any, expanded: boolean, showTask: boolean): string[] {
	const icon = { queued: theme.fg("dim", "○"), running: theme.fg("accent", "▸"), done: theme.fg("success", "✓"), failed: theme.fg("error", "✗") }[r.status];
	let head = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
	if (showTask) head += ` ${theme.fg("dim", oneLine(r.task, 70))}`;
	if (r.usage.turns) head += theme.fg("muted", `  ${r.usage.turns} turns${r.usage.cost ? `, $${r.usage.cost.toFixed(3)}` : ""}`);
	const lines = [head];
	if (expanded) {
		if (showTask === false) lines.push(theme.fg("dim", `  task: ${oneLine(r.task, 300)}`));
		// Последняя реплика и есть ответ: он ниже целиком
		const answer = r.output.trim().slice(0, SNIPPET);
		for (const e of r.log) if (!(e.type === "text" && r.output && e.text === answer)) lines.push(...logLine(e, theme, true));
		if (r.status === "failed" && r.error) lines.push(theme.fg("error", `  ${oneLine(r.error, 300)}`));
		if (r.output) {
			lines.push(theme.fg("muted", "  ── answer ──"));
			const out = r.output.split("\n");
			lines.push(...out.slice(0, 60).map((l) => `  ${l}`));
			if (out.length > 60) lines.push(theme.fg("muted", `  … ${out.length - 60} more lines`));
		}
		if (r.sessionFile) lines.push(theme.fg("dim", `  session: ${r.sessionFile}`));
	} else if (r.status === "running") {
		// Только записи лога, ответ не дублируем
		const tail = r.log.slice(-COLLAPSED_LINES);
		for (const e of tail) lines.push(...logLine(e, theme, false));
	} else if (r.status === "failed" && r.error) lines.push(theme.fg("error", `  ${oneLine(r.error, 160)}`));
	else if (r.output) lines.push(`  ${theme.fg("muted", oneLine(r.output, 140))}`);
	return lines;
}

// --- инструмент

const Step = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task for the agent; in chain mode {previous} is replaced with the previous step's output" }),
});

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;

	pi.on("session_start", async () => prune());

	const userAgents = loadAgents(path.join(getAgentDir(), "agents"), "user");
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a subagent: a separate pi process with its own context that returns only its final answer. " +
			"Use it for exploration or research that would flood your context, and to run independent tasks in parallel. " +
			"The subagent has not seen this conversation: give it a self-contained task with all needed context. " +
			"Modes (exactly one): single {agent, task}; parallel {tasks: [{agent, task}]}, up to " +
			`${MAX_PARALLEL_TASKS}; chain {chain: [{agent, task}]} where {previous} is the previous step's output. ` +
			`Agents: ${userAgents.map((a) => `${a.name} - ${a.description}`).join("; ") || "none"}` +
			" (project agents from .pi/agents may add more).",
		promptSnippet: "subagent: Delegate tasks to subagents with isolated context (single, parallel, chain)",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Single mode: agent name" })),
			task: Type.Optional(Type.String({ description: "Single mode: task" })),
			tasks: Type.Optional(Type.Array(Step, { description: "Parallel mode" })),
			chain: Type.Optional(Type.Array(Step, { description: "Chain mode" })),
		}),

		async execute(_id, params, signal, onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			const parentSession = ctx.sessionManager.getSessionFile();
			const defaults: Defaults = {
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinking: pi.getThinkingLevel(),
				sessionDir: parentSession ? path.join(subagentsRoot(), ctx.sessionManager.getSessionId()) : undefined,
				parentSession,
			};
			const modes = [params.agent && params.task, params.tasks?.length, params.chain?.length].filter(Boolean).length;
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}` }],
					details: {},
					isError: true,
				};
			}
			const mode: Details["mode"] = params.chain?.length ? "chain" : params.tasks?.length ? "parallel" : "single";
			const steps = params.chain ?? params.tasks ?? [{ agent: params.agent!, task: params.task! }];
			if (mode === "parallel" && steps.length > MAX_PARALLEL_TASKS) {
				return { content: [{ type: "text", text: `Too many parallel tasks: max ${MAX_PARALLEL_TASKS}` }], details: {}, isError: true };
			}
			const live = steps.map((s) => newResult(s.agent, s.task));

			// Обновления не чаще раза в 150 мс: события субагентов идут пачками
			let timer: ReturnType<typeof setTimeout> | undefined;
			const flush = () => {
				timer = undefined;
				const text = live.map((r) => `${r.agent}: ${r.status}${r.usage.turns ? `, turn ${r.usage.turns}` : ""}`).join("\n");
				onUpdate?.({ content: [{ type: "text", text }], details: { mode, results: live } as Details });
			};
			const changed = () => {
				if (!timer) timer = setTimeout(flush, 150);
			};
			const done = (content: string, isError: boolean) => {
				if (timer) clearTimeout(timer);
				return { content: [{ type: "text" as const, text: content }], details: { mode, results: live } as Details, isError, usage: toolUsage(live) };
			};

			if (mode === "chain") {
				let previous = "";
				for (const [i, r] of live.entries()) {
					r.task = r.task.replaceAll("{previous}", previous);
					await runAgent(agents, r, defaults, signal, changed);
					if (!r.ok) {
						for (const rest of live.slice(i + 1)) rest.status = "failed";
						return done(`Chain stopped at step ${i + 1} (${r.agent}): ${render(r)}\n\n(${usageLine(live)})`, true);
					}
					previous = r.output;
				}
				return done(`${render(live.at(-1)!)}\n\n(${usageLine(live)})`, false);
			}

			if (mode === "parallel") {
				await mapLimited(live, MAX_CONCURRENCY, (r) => runAgent(agents, r, defaults, signal, changed));
				const ok = live.filter((r) => r.ok).length;
				const text = live.map((r, i) => `### ${i + 1}. [${r.agent}] ${r.ok ? "completed" : "failed"}\n\n${render(r)}`).join("\n\n---\n\n");
				return done(`Parallel: ${ok}/${live.length} succeeded\n\n${text}\n\n(${usageLine(live)})`, ok === 0);
			}

			const r = await runAgent(agents, live[0], defaults, signal, changed);
			return done(`${render(r)}\n\n(${usageLine([r])})`, !r.ok);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("subagent "));
			if (args.chain?.length) text += theme.fg("accent", `chain ${args.chain.map((s: any) => s.agent).join(" → ")}`);
			else if (args.tasks?.length) text += theme.fg("accent", `parallel ×${args.tasks.length}`);
			else text += `${theme.fg("accent", args.agent ?? "")} ${theme.fg("dim", oneLine(args.task ?? "", 90))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as Details | undefined;
			if (!d?.results?.length) {
				const t = result.content?.find((c: any) => c.type === "text") as { text: string } | undefined;
				return new Text(theme.fg("error", t?.text ?? ""), 0, 0);
			}
			const showTask = d.mode !== "single";
			const lines = d.results.flatMap((r) => renderAgent(r, theme, expanded, showTask));
			const finished = d.results.every((r) => r.status === "done" || r.status === "failed");
			if (finished && !expanded) lines.push(theme.fg("dim", "  ctrl+o: full log · /subagents: open session"));
			if (finished && d.results.length > 1) lines.push(theme.fg("muted", `  ${usageLine(d.results)}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("subagents", {
		description: "Open a subagent session of this conversation (or go back to the parent)",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) return ctx.ui.notify("Wait until the agent finishes", "warning");
			const root = subagentsRoot();
			const current = ctx.sessionManager.getSessionFile();
			const inSubagent = !!current && current.startsWith(root + path.sep);
			const dir = inSubagent ? path.dirname(current!) : path.join(root, ctx.sessionManager.getSessionId());
			const entries = readIndex(dir).reverse();
			const parent = entries.find((e) => e.parent)?.parent;

			const options: { label: string; file: string }[] = [];
			if (inSubagent && parent && fs.existsSync(parent)) options.push({ label: "← back to parent session", file: parent });
			for (const e of entries) {
				if (e.file === current) continue;
				options.push({ label: `${e.ok ? "✓" : "✗"} ${ago(e.time).padEnd(8)} ${e.agent}: ${oneLine(e.task, 70)}`, file: e.file });
			}
			if (!options.length) return ctx.ui.notify("No subagent sessions in this conversation", "info");
			const choice = await ctx.ui.select(inSubagent ? "Subagent sessions (you are in one):" : "Subagent sessions:", options.map((o) => o.label));
			const picked = options.find((o) => o.label === choice);
			if (!picked) return;
			await ctx.switchSession(picked.file, {
				withSession: async (c) => {
					if (picked.file !== parent) c.ui.notify("Subagent session. /subagents to go back to the parent", "info");
				},
			});
		},
	});
}
