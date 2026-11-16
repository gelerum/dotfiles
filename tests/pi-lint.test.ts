import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../pi/.pi/agent/extensions/lint.ts";

let root: string;
let handlers: Record<string, any>;
let exec: ReturnType<typeof mock>;
let ctx: any;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lint-test-"));
	fs.mkdirSync(path.join(root, ".venv/bin"), { recursive: true });
	for (const name of ["ruff", "eslint"]) {
		const bin = path.join(root, ".venv/bin", name);
		fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}
	for (const name of ["ruff.toml", "tsconfig.json", "eslint.config.js", ".prettierrc"]) fs.writeFileSync(path.join(root, name), "{}");
	handlers = {};
	exec = mock(async () => ({ stdout: "", stderr: "", code: 0 }));
	ctx = { cwd: root };
	extension({ on: (name: string, fn: any) => { handlers[name] = fn; }, exec } as any);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function event(file: string, toolName = "edit", isError = false) {
	return { toolName, isError, input: { path: file }, content: [{ type: "text", text: "Edit applied" }] };
}

test("clean edit leaves content unchanged and runs only non-fixing lint", async () => {
	const file = path.join(root, "a.py");
	const source = "x=  1\n";
	fs.writeFileSync(file, source);
	expect(await handlers.tool_result(event(file), ctx)).toBeUndefined();
	expect(exec).toHaveBeenCalledTimes(1);
	expect(exec.mock.calls[0][1]).toEqual(["check", "--output-format=concise", "--quiet", "--no-fix", file]);
	expect(fs.readFileSync(file, "utf8")).toBe(source);
	// No hook remains to format, inject saved diffs, or force a continuation.
	expect(handlers.before_agent_start).toBeUndefined();
	expect(handlers.agent_before_settle).toBeUndefined();
	expect(handlers.tool_call).toBeUndefined();
});

test("write diagnostics preserve tool result and exclude other files", async () => {
	const file = path.join(root, "a.py");
	fs.writeFileSync(file, "print(missing)\n");
	exec.mockImplementation(async () => ({ stdout: `${file}:1:7: F821 Undefined name missing\n${root}/other.py:2:1: F401 unused\n`, stderr: "", code: 1 }));
	const result = await handlers.tool_result(event(file, "write"), ctx);
	expect(result.content[0].text).toBe("Edit applied");
	expect(result.content[1].text).toContain("a.py:1: F821");
	expect(result.content[1].text).not.toContain("other.py");
});

test("eslint reports errors only and explicitly disables fixes", async () => {
	const file = path.join(root, "a.ts");
	fs.writeFileSync(file, "const x=1\n");
	exec.mockImplementation(async () => ({ stdout: JSON.stringify([{ filePath: file, messages: [
		{ severity: 1, line: 1, message: "warning" },
		{ severity: 2, line: 1, message: "bad code", ruleId: "test-rule" },
	] }]), stderr: "", code: 1 }));
	const result = await handlers.tool_result(event(file), ctx);
	expect(exec.mock.calls[0][1]).toEqual(["--format", "json", "--no-fix", file]);
	expect(result.content[1].text).toContain("bad code (test-rule)");
	expect(result.content[1].text).not.toContain("warning");
});

test("failed edits, reads, and files outside the project do not invoke lint", async () => {
	await handlers.tool_result(event(path.join(root, "a.py"), "edit", true), ctx);
	await handlers.tool_result(event(path.join(root, "a.py"), "read"), ctx);
	await handlers.tool_result(event(path.join(root, "..", "outside.py")), ctx);
	expect(exec).not.toHaveBeenCalled();
});
