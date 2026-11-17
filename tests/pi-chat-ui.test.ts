import { beforeEach, expect, mock, test } from "bun:test";

// The production host supplies pi-tui. Unit tests exercise the extension's
// decisions without starting a terminal or requiring a running pi process.
class TestText {
	constructor(public text: string) {}
	render() { return this.text.split("\n"); }
	invalidate() {}
}
class TestContainer {
	children: any[] = [];
	addChild(child: any) { this.children.push(child); }
	render(width: number) { return this.children.flatMap((child) => child.render(width)); }
	invalidate() {}
}
const strip = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
mock.module("@earendil-works/pi-tui", () => ({
	Text: TestText,
	Container: TestContainer,
	stripTerminalSequences: strip,
	truncateToWidth: (s: string, width: number, ellipsis = "…") => {
		const chars = Array.from(strip(s));
		return chars.length <= width ? s : chars.slice(0, Math.max(0, width - 1)).join("") + (width ? ellipsis : "");
	},
}));
const { default: extension, quotedDraft, selectionText, assistantReplies, toolTitle } = await import("../pi/.pi/agent/extensions/chat-ui.ts");

let handlers: Record<string, any>;
let commands: Record<string, any>;
let shortcuts: Record<string, any>;
let resolver: any;
let ctx: any;
let host: any;
let draft: string;
let branch: any[];
let entries: any[];
let widget: any;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

beforeEach(() => {
	handlers = {}; commands = {}; shortcuts = {}; entries = [];
	draft = "My existing question";
	branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "First paragraph.\n\nSecond paragraph." }] } }];
	host = { getActiveSelectionText: mock(() => "Selected excerpt"), resetTextSelection: mock(() => {}) };
	ctx = {
		mode: "tui", sessionManager: { getBranch: () => branch },
		ui: {
			setToolsExpanded: mock(() => {}),
			setWidget: mock((_name: string, factory: any) => { widget = factory(host); }),
			notify: mock(() => {}), getEditorText: () => draft,
			setEditorText: mock((text: string) => { draft = text; }),
			select: mock(async (_title: string, choices: string[]) => choices[0]),
			editor: mock(async () => "Second paragraph."),
		},
	};
	extension({
		on: (name: string, handler: any) => { handlers[name] = handler; },
		registerToolRenderer: (r: any) => { resolver = r; },
		registerCommand: (name: string, command: any) => { commands[name] = command; },
		registerShortcut: (key: string, shortcut: any) => { shortcuts[key] = shortcut; },
		appendEntry: (...args: any[]) => { entries.push(args); },
	} as any);
	handlers.session_start({}, ctx);
});

function renderContext(overrides: any = {}) {
	return {
		args: {}, state: {}, toolCallId: "tool-1", cwd: "/project", expanded: false,
		isPartial: false, isError: false, durationMs: 125,
		invalidate: mock(() => {}), keyHint: (_key: string, text: string) => `Ctrl+O ${text}`,
		...overrides,
	};
}
const output = (text: string, details?: any) => ({ content: [{ type: "text", text }], details });

function row(name: string, args: any, result: any, options: any = {}, original?: any) {
	const renderer = resolver(name, () => original);
	const context = renderContext({ args, ...options });
	const call = renderer.renderCall(args, theme, context);
	const body = renderer.renderResult(result, { expanded: context.expanded, isPartial: context.isPartial }, theme, context);
	return { renderer, context, call, body };
}

test("compact shell output hides commands and logs without changing tool results", () => {
	const result = output("private output\n".repeat(1000));
	const before = JSON.stringify(result);
	const r = row("bash", { command: "echo secret\nrun --verbose" }, result);
	expect(r.call.render(80)).toHaveLength(1);
	expect(r.call.render(80).join("")).toContain("✓ Shell");
	expect(r.call.render(80).join("")).not.toContain("secret");
	expect(r.body.render(80)).toEqual([]);
	expect(JSON.stringify(result)).toBe(before);
	expect(handlers.tool_result).toBeUndefined();
});

test("errors stay visible with a bounded preview and an expansion hint", () => {
	const r = row("bash", { command: "failing command" }, output("Failure\nline 2\nline 3\nline 4"), { isError: true });
	expect(r.call.render(80)[0]).toContain("✗ Shell");
	expect(r.body.render(80)).toEqual(["Failure", "line 2", "line 3", "Ctrl+O for details"]);
});

test("lint findings remain visible even when the edit itself succeeded", () => {
	const r = row("edit", { path: "/project/main.nix" }, output("Edit applied\n\nLint errors in this file, fix them:\nstatix:\nmain.nix:1: bad code"));
	expect(r.call.render(100)[0]).toContain("! Edit · main.nix · Lint findings");
	expect(r.body.render(100).join("\n")).toContain("main.nix:1: bad code");
});

test("expanded and verbose edit/write rows keep full lint findings beside the original component", async () => {
	for (const mode of ["expanded", "verbose"]) {
		if (mode === "verbose") await commands.ui.handler("verbose", ctx);
		for (const name of ["edit", "write"]) {
			const originalComponent = new TestText(name === "edit" ? "Original diff" : "");
			const original = { renderResult: mock(() => originalComponent) };
			const result = output("Applied\nLint errors in this file, fix them:\nstatix:\nfirst\nsecond\nthird\nfourth");
			const r = row(name, { path: "a.nix" }, result, { expanded: mode === "expanded" }, original);
			expect(r.body.render(100).join("\n")).toContain("fourth");
			expect(r.body.children[0]).toBe(originalComponent);
			r.renderer.renderResult(result, { expanded: mode === "expanded", isPartial: false }, theme, r.context);
			expect(original.renderResult.mock.calls[1][3].lastComponent).toBe(originalComponent);
		}
	}
});

test("streaming shell output remains compact and is never marked successful", () => {
	const r = row("bash", { command: "long task" }, output("streaming logs"), { isPartial: true, durationMs: undefined });
	expect(r.call.render(80)[0]).toStartWith("… Shell");
	expect(r.body.render(80)).toEqual([]);
});

test("expanded rows use the original renderers with isolated state and components", () => {
	const original = {
		renderCall: mock((_args: any, _theme: any, context: any) => {
			expect(context.state.chatUI).toBeUndefined();
			context.state.saved = true;
			return new TestText("Original command");
		}),
		renderResult: mock((_result: any, _options: any, _theme: any, context: any) => {
			expect(context.state.saved).toBe(true);
			return new TestText("Full original output");
		}),
	};
	const r = row("bash", { command: "exact command" }, output("full logs"), { expanded: true }, original);
	expect(r.call.render()).toEqual(["Original command"]);
	expect(r.body.render()).toEqual(["Full original output"]);
	r.renderer.renderCall(r.context.args, theme, r.context);
	expect(original.renderCall.mock.calls[1][2].lastComponent).toBe(r.call);
});

test("expanded tools without custom renderers keep all arguments and text blocks", () => {
	const result = { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] };
	const r = row("mcp__docs__query", { query: "full argument" }, result, { expanded: true });
	expect(r.call.render().join("\n")).toContain("full argument");
	expect(r.body.render()).toEqual(["first", "second"]);
});

test("interactive tool renderers are preserved", () => {
	const original = { renderCall() {} };
	expect(resolver("questionnaire", () => original)).toBe(original);
	expect(resolver("todo", () => original)).toBe(original);
});

test("compact headers stay single-line and mark truncation and images", () => {
	expect(toolTitle("read", { path: "/project/a\nmalicious header" }, "/project")).not.toContain("\n");
	const r = row("read", { path: "/project/a.txt" }, output("many lines", { truncation: { truncated: true } }));
	expect(r.call.render(100)[0]).toContain("Output truncated");
	expect(r.call.render(12)[0].length).toBeLessThanOrEqual(12);
	const image = row("read", { path: "image.png" }, { content: [{ type: "image", data: "unchanged" }] });
	expect(image.call.render(80)[0]).toContain("Image");
});

test("verbose mode persists the preference, redraws existing rows and restores on reload", async () => {
	const r = row("bash", { command: "cmd" }, output("logs"));
	await commands.ui.handler("verbose", ctx);
	expect(entries).toEqual([["chat-ui-preferences", { compact: false }]]);
	expect(r.context.invalidate).toHaveBeenCalled();
	expect(ctx.ui.setToolsExpanded).toHaveBeenLastCalledWith(true);
	branch.push({ type: "custom", customType: "chat-ui-preferences", data: { compact: false } });
	handlers.session_start({}, ctx);
	expect(ctx.ui.setToolsExpanded).toHaveBeenLastCalledWith(true);
	await commands.ui.handler("compact", ctx);
	expect(ctx.ui.setToolsExpanded).toHaveBeenLastCalledWith(false);
});

test("selected text is quoted directly without clipboard access or a picker", async () => {
	await shortcuts["alt+q"].handler(ctx);
	expect(draft).toBe("> Selected excerpt\n\nMy existing question");
	expect(ctx.ui.select).not.toHaveBeenCalled();
	expect(ctx.ui.editor).not.toHaveBeenCalled();
	expect(host.resetTextSelection).toHaveBeenCalled();
});

test("quotes preserve multiline math, blank lines, Unicode and the exact draft", () => {
	const text = "\x1b[31mEquation\x1b[0m\r\n\r\n$$\r\nα + β = 1\r\n$$";
	expect(quotedDraft(text, "  keep my draft\n")).toBe("> Equation\n>\n> $$\n> α + β = 1\n> $$\n\n  keep my draft\n");
});

test("missing or changed selection APIs safely fall back to an excerpt picker", async () => {
	delete host.getActiveSelectionText;
	await commands.quote.handler("", ctx);
	expect(ctx.ui.select).toHaveBeenCalled();
	expect(draft).toBe("> Second paragraph.\n\nMy existing question");
	expect(selectionText({ getActiveSelectionText() { throw new Error("changed API"); } })).toBeUndefined();
});

test("source picker bypasses rendered selection and preserves Markdown math", async () => {
	branch = [{ type: "message", message: { role: "assistant", content: "Math: $x^2$ is positive." } }];
	ctx.ui.editor.mockResolvedValue("$x^2$");
	await commands.quote.handler("--pick", ctx);
	expect(ctx.ui.select).toHaveBeenCalled();
	expect(draft).toBe("> $x^2$\n\nMy existing question");
});

test("cancelling either quote dialog leaves the draft untouched", async () => {
	host.getActiveSelectionText.mockReturnValue(undefined);
	ctx.ui.select.mockResolvedValueOnce(undefined);
	await commands.quote.handler("", ctx);
	expect(draft).toBe("My existing question");
	ctx.ui.editor.mockResolvedValueOnce(undefined);
	await commands.quote.handler("", ctx);
	expect(draft).toBe("My existing question");
});

test("edited quotes must be unchanged contiguous excerpts", async () => {
	host.getActiveSelectionText.mockReturnValue(undefined);
	ctx.ui.editor.mockResolvedValue("Invented statement");
	await commands.quote.handler("", ctx);
	expect(draft).toBe("My existing question");
	expect(ctx.ui.notify.mock.calls[0][0]).toContain("unchanged, contiguous excerpt");
});

test("oversized selections are rejected rather than silently truncated", async () => {
	host.getActiveSelectionText.mockReturnValue("x".repeat(20_001));
	await commands.quote.handler("", ctx);
	expect(draft).toBe("My existing question");
	expect(ctx.ui.notify.mock.calls[0][0]).toContain("too large");
});

test("manual quotes do not submit a prompt and work without previous replies", async () => {
	branch = [];
	await commands.quote.handler("Exact manual quote", ctx);
	expect(draft).toBe("> Exact manual quote\n\nMy existing question");
	expect(entries).toEqual([]);
});

test("reply picker ignores thinking, tools, user messages and abandoned branches", () => {
	const messages = [
		{ type: "message", message: { role: "user", content: "not a reply" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } },
		...branch,
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
	];
	expect(assistantReplies(messages)).toEqual(["First paragraph.\n\nSecond paragraph."]);
});

test("selection cleanup failures do not undo a successfully inserted quote", async () => {
	host.resetTextSelection.mockImplementation(() => { throw new Error("changed cleanup API"); });
	await shortcuts["alt+q"].handler(ctx);
	expect(draft).toBe("> Selected excerpt\n\nMy existing question");
});

test("empty history and cancelled concurrent pickers never replace the draft", async () => {
	host.getActiveSelectionText.mockReturnValue(undefined);
	branch = [];
	await commands.quote.handler("", ctx);
	expect(ctx.ui.notify.mock.calls[0][0]).toContain("No assistant replies");
	branch = [{ type: "message", message: { role: "assistant", content: "A reply" } }];
	let close: (choice: undefined) => void = () => {};
	ctx.ui.select.mockImplementation(() => new Promise((resolve) => { close = resolve; }));
	const first = commands.quote.handler("", ctx);
	await commands.quote.handler("Do not open a second quote", ctx);
	expect(draft).toBe("My existing question");
	expect(ctx.ui.select).toHaveBeenCalledTimes(1);
	close(undefined);
	await first;
	await commands.quote.handler("Allowed after cancellation", ctx);
	expect(draft).toContain("> Allowed after cancellation");
});

test("non-TUI modes do not touch the editor or terminal", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		ctx.mode = mode;
		ctx.ui.setWidget.mockClear();
		handlers.session_start({}, ctx);
		await commands.quote.handler("quote", ctx);
		await commands.ui.handler("verbose", ctx);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		expect(draft).toBe("My existing question");
	}
});
