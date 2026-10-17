/**
 * Список задач для многошаговой работы, как TodoWrite в Claude Code: модель одним вызовом
 * передаёт весь список со статусами. Основа - пример todo.ts из pi 1.3.0: состояние живёт
 * в details результатов инструмента, поэтому при /fork и переходах по дереву список
 * соответствует этому месту истории.
 *
 * - пока есть незакрытые задачи, список виден над полем ввода, прогресс - в строке состояния
 * - после сжатия истории модель получает актуальный список: старые вызовы ушли в сводку
 * - /todos - показать список; в субагентах (PI_SUBAGENT=1) не регистрируется
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "done";

interface Todo {
	text: string;
	status: Status;
}

interface TodoDetails {
	todos: Todo[];
}

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };

const show = (todos: Todo[]) => todos.map((t, i) => `${MARK[t.status]} ${i + 1}. ${t.text}`).join("\n");
const open = (todos: Todo[]) => todos.some((t) => t.status !== "done");

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	let todos: Todo[] = [];

	function render(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const done = todos.filter((t) => t.status === "done").length;
		ctx.ui.setStatus("todo", open(todos) ? `todo ${done}/${todos.length}` : undefined);
		ctx.ui.setWidget("todo", open(todos) ? show(todos).split("\n") : undefined);
	}

	// Последний результат инструмента на текущей ветке и есть состояние
	function reconstruct(ctx: ExtensionContext): void {
		todos = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.todos) todos = details.todos;
		}
		render(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("session_compact", async () => {
		if (!open(todos)) return;
		pi.sendMessage(
			{ customType: "todo-state", content: `Current todo list (kept across context compaction):\n${show(todos)}`, display: false },
			{ deliverAs: "nextTurn" },
		);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Plan and track a multi-step task. Pass the complete list every time: it replaces the previous one. " +
			"Call without todos to read the current list.",
		promptSnippet: "todo: Plan and track multi-step tasks",
		promptGuidelines: [
			"Use todo for tasks with 3 or more distinct steps; skip it for simple or conversational requests",
			"Keep exactly one todo in_progress while working; mark it done right after finishing it, not in batches",
			"Add todos you discover along the way; remove ones that turn out unnecessary",
		],
		parameters: Type.Object({
			todos: Type.Optional(
				Type.Array(
					Type.Object({
						text: Type.String({ description: "What to do, imperative" }),
						status: StringEnum(["pending", "in_progress", "done"] as const),
					}),
					{ description: "The full updated list" },
				),
			),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.todos) todos = params.todos.map((t) => ({ text: t.text.trim(), status: t.status }));
			render(ctx);
			const text = todos.length ? show(todos) : "No todos";
			return { content: [{ type: "text", text }], details: { todos: [...todos] } as TodoDetails };
		},

		renderResult(result, _options, theme) {
			const list = (result.details as TodoDetails | undefined)?.todos ?? [];
			if (!list.length) return new Text(theme.fg("dim", "No todos"), 0, 0);
			const lines = list.map((t) => {
				if (t.status === "done") return `${theme.fg("success", "✓")} ${theme.fg("dim", t.text)}`;
				if (t.status === "in_progress") return `${theme.fg("accent", "▸")} ${theme.fg("text", t.text)}`;
				return `${theme.fg("dim", "○")} ${theme.fg("muted", t.text)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the todo list on the current branch",
		handler: async (_args, ctx) => {
			ctx.ui.notify(todos.length ? show(todos) : "No todos", "info");
		},
	});
}
