/**
 * Субагенты: задача уходит отдельному процессу `pi --mode json -p --no-session` со своим
 * контекстом, обратно приходит только итоговый ответ. По мотивам examples/extensions/subagent.
 *
 * - режимы: один агент (agent + task), параллельно (tasks), цепочка (chain, {previous} - вывод
 *   предыдущего шага)
 * - агенты - markdown с frontmatter (name, description, model, tools, thinking) в
 *   ~/.pi/agent/agents/ и, если проект доверенный, в .pi/agents/ проекта (перекрывают по имени)
 * - модель и уровень thinking по умолчанию - как у родителя
 * - в дочерних процессах PI_SUBAGENT=1 (инструмент subagent не регистрируется, без рекурсии)
 *   и PI_MEMORY_REFLECT=0 (без рефлексии памяти при выходе). Память в промпт ребёнку
 *   попадает - это только чтение индекса; линтер срабатывает лишь на write/edit
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP = 50 * 1024;

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
}

interface Result {
	agent: string;
	task: string;
	model?: string;
	output: string;
	ok: boolean;
	error?: string;
	usage: Usage;
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

interface Defaults {
	cwd: string;
	model?: string;
	thinking?: string;
}

async function runAgent(
	agents: Agent[],
	name: string,
	task: string,
	defaults: Defaults,
	signal: AbortSignal | undefined,
	progress: (status: string) => void,
): Promise<Result> {
	const agent = agents.find((a) => a.name === name);
	const result: Result = { agent: name, task, output: "", ok: false, usage: emptyUsage() };
	if (!agent) {
		result.error = `Unknown agent "${name}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`;
		return result;
	}

	const args = ["--mode", "json", "-p", "--no-session"];
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
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const msg = event.message;
					const u = msg.usage ?? {};
					result.usage.turns++;
					result.usage.input += u.input ?? 0;
					result.usage.output += u.output ?? 0;
					result.usage.cacheRead += u.cacheRead ?? 0;
					result.usage.cacheWrite += u.cacheWrite ?? 0;
					result.usage.cost += u.cost?.total ?? 0;
					if (msg.stopReason) stopReason = msg.stopReason;
					if (msg.errorMessage) result.error = msg.errorMessage;
					const text = (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
					if (text) lastText = text;
					const tools = (msg.content ?? []).filter((b: any) => b.type === "toolCall").map((b: any) => b.name);
					progress(tools.length ? `turn ${result.usage.turns}: ${tools.join(", ")}` : `turn ${result.usage.turns}`);
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

function render(r: Result): string {
	return r.ok ? cap(r.output || "(no output)") : `FAILED: ${r.error}${r.output ? `\n\n${cap(r.output)}` : ""}`;
}

// --- инструмент

const Step = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task for the agent; in chain mode {previous} is replaced with the previous step's output" }),
});

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;

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
			const defaults: Defaults = {
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinking: pi.getThinkingLevel(),
			};
			const update = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });
			const modes = [params.agent && params.task, params.tasks?.length, params.chain?.length].filter(Boolean).length;
			if (modes !== 1) {
				return {
					content: [{ type: "text", text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}` }],
					details: {},
					isError: true,
				};
			}

			if (params.chain?.length) {
				const results: Result[] = [];
				let previous = "";
				for (const [i, step] of params.chain.entries()) {
					const r = await runAgent(agents, step.agent, step.task.replaceAll("{previous}", previous), defaults, signal, (s) =>
						update(`chain step ${i + 1}/${params.chain!.length} (${step.agent}): ${s}`),
					);
					results.push(r);
					if (!r.ok) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${render(r)}\n\n(${usageLine(results)})` }],
							details: { results },
							isError: true,
						};
					}
					previous = r.output;
				}
				return { content: [{ type: "text", text: `${render(results.at(-1)!)}\n\n(${usageLine(results)})` }], details: { results } };
			}

			if (params.tasks?.length) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return { content: [{ type: "text", text: `Too many parallel tasks: max ${MAX_PARALLEL_TASKS}` }], details: {}, isError: true };
				}
				const status = params.tasks.map(() => "queued");
				const results = await mapLimited(params.tasks, MAX_CONCURRENCY, async (t, i) => {
					const r = await runAgent(agents, t.agent, t.task, defaults, signal, (s) => {
						status[i] = s;
						update(status.map((st, j) => `${j + 1}. ${params.tasks![j].agent}: ${st}`).join("\n"));
					});
					status[i] = r.ok ? "done" : "failed";
					return r;
				});
				const ok = results.filter((r) => r.ok).length;
				const text = results.map((r, i) => `### ${i + 1}. [${r.agent}] ${r.ok ? "completed" : "failed"}\n\n${render(r)}`).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${text}\n\n(${usageLine(results)})` }],
					details: { results },
					isError: ok === 0,
				};
			}

			const r = await runAgent(agents, params.agent!, params.task!, defaults, signal, (s) => update(`${params.agent}: ${s}`));
			return { content: [{ type: "text", text: `${render(r)}\n\n(${usageLine([r])})` }], details: { results: [r] }, isError: !r.ok };
		},
	});
}
