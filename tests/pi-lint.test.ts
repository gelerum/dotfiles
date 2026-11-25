import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
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
	for (const name of ["ruff", "eslint", "statix", "deadnix"]) {
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

test("Ruff style-only findings leave model-facing content untouched and preserve edit details", async () => {
	const file = path.join(root, "a.py");
	fs.writeFileSync(file, "import sys\nimport os\n");
	exec.mockImplementation(async () => ({
		stdout: `${file}:1:1: I001 [*] Import block is un-sorted or un-formatted\n${file}:3:89: E501 Line too long\n`,
		stderr: "", code: 1,
	}));
	const result = await handlers.tool_result({ ...event(file), details: { diff: "original diff" } }, ctx);
	expect(result.content).toBeUndefined();
	expect(result.details.diff).toBe("original diff");
	expect(result.details.lintStyle).toContain("I001");
	expect(result.details.lintStyle).toContain("E501");
});

test("Ruff style does not crowd out actionable findings or hide other fixable rules", async () => {
	const file = path.join(root, "a.py");
	fs.writeFileSync(file, "print(missing)\n");
	exec.mockImplementation(async () => ({
		stdout: `${file}:1:1: I001 [*] Unsorted imports\n`.repeat(21) +
			`${file}:2:1: F401 [*] Unused import\n${file}:3:7: F821 Undefined name missing\n`,
		stderr: "", code: 1,
	}));
	const result = await handlers.tool_result(event(file, "write"), ctx);
	expect(result.content[1].text).toContain("F821");
	expect(result.content[1].text).toContain("F401");
	expect(result.content[1].text).not.toContain("I001");
	expect(result.details.lintStyle).toContain("(1 more)");
	expect(result.details.lintStyle).not.toContain("F821");
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

test("Nix lint runs both tools without a config and never rewrites the file", async () => {
	for (const name of ["ruff.toml", "eslint.config.js"]) fs.unlinkSync(path.join(root, name));
	const file = path.join(root, "module.nix");
	const source = "{ unused }: let x = 1; in {}\n";
	fs.writeFileSync(file, source);
	exec.mockImplementation(async (bin: string) => ({
		stdout: bin.endsWith("statix")
			? `${file}>1:3:W:20:Unused pattern\n${root}/other.nix>1:1:W:20:Other file\n`
			: JSON.stringify({ file, results: [{ line: 1, column: 17, message: "Unused let binding: x" }] }) + "\n",
		stderr: "", code: 0,
	}));
	const result = await handlers.tool_result(event(file), ctx);
	expect(exec.mock.calls.map((call) => call[1])).toEqual([
		["check", "--format", "errfmt", file],
		["--output-format", "json", file],
	]);
	expect(result.content[1].text).toContain("statix:\nmodule.nix:1: W:20:Unused pattern");
	expect(result.content[1].text).toContain("deadnix:\nmodule.nix:1: Unused let binding: x");
	expect(result.content[1].text).not.toContain("other.nix");
	expect(fs.readFileSync(file, "utf8")).toBe(source);
});

test("clean Nix files do not change tool results", async () => {
	const file = path.join(root, "clean.nix");
	fs.writeFileSync(file, "{}\n");
	expect(await handlers.tool_result(event(file, "write"), ctx)).toBeUndefined();
	expect(exec).toHaveBeenCalledTimes(2);
});

test("a broken Nix linter does not hide the edit or stop other checks", async () => {
	const file = path.join(root, "bad.nix");
	fs.writeFileSync(file, "{}\n");
	exec.mockImplementation(async (bin: string) => {
		if (bin.endsWith("statix")) throw new Error("private stderr");
		return { stdout: JSON.stringify({ file, results: [{ line: 1, message: "Unused binding" }] }), stderr: "", code: 0 };
	});
	const result = await handlers.tool_result(event(file), ctx);
	expect(result.content[0].text).toBe("Edit applied");
	expect(result.content[1].text).toContain("statix: check failed");
	expect(result.content[1].text).toContain("deadnix:");
	expect(result.content[1].text).not.toContain("private stderr");
});

test("statix stderr with status zero is a failed check, not a clean file", async () => {
	const file = path.join(root, "a.nix");
	fs.writeFileSync(file, "{}\n");
	exec.mockImplementation(async (bin: string) => ({
		stdout: "", stderr: bin.endsWith("statix") ? "private config error" : "", code: 0,
	}));
	const result = await handlers.tool_result(event(file), ctx);
	expect(result.content[0].text).toBe("Edit applied");
	expect(result.content[1].text).toContain("statix: check failed");
	expect(result.content[1].text).not.toContain("private config error");
	expect(exec).toHaveBeenCalledTimes(2);
});

test("malformed deadnix output is reported without throwing", async () => {
	const file = path.join(root, "a.nix");
	fs.writeFileSync(file, "{}\n");
	exec.mockImplementation(async (bin: string) => ({ stdout: bin.endsWith("deadnix") ? "not-json" : "", stderr: "", code: 0 }));
	expect((await handlers.tool_result(event(file), ctx)).content[1].text).toContain("deadnix: check failed");
});

test("missing Nix binaries are skipped", async () => {
	for (const name of ["statix", "deadnix"]) fs.unlinkSync(path.join(root, ".venv/bin", name));
	const oldPath = process.env.PATH;
	process.env.PATH = "";
	try {
		expect(await handlers.tool_result(event(path.join(root, "a.nix")), ctx)).toBeUndefined();
		expect(exec).not.toHaveBeenCalled();
	} finally {
		process.env.PATH = oldPath;
	}
});

const nixIntegration = process.env.STATIX_TEST_BIN && process.env.DEADNIX_TEST_BIN ? test : test.skip;
nixIntegration("real Nix binaries produce diagnostics through the hook without modifying source", async () => {
	for (const [name, bin] of [["statix", process.env.STATIX_TEST_BIN!], ["deadnix", process.env.DEADNIX_TEST_BIN!]]) {
		const target = path.join(root, ".venv/bin", name);
		fs.unlinkSync(target);
		fs.symlinkSync(bin, target);
	}
	exec.mockImplementation(async (bin: string, args: string[]) => {
		const out = spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 15000 });
		if (out.error) throw out.error;
		return { stdout: out.stdout, stderr: out.stderr, code: out.status ?? 1 };
	});
	const file = path.join(root, "real.nix");
	const source = "{ unused }: (true == true)\n";
	fs.writeFileSync(file, source);
	const result = await handlers.tool_result(event(file), ctx);
	expect(result.content[1].text).toContain("statix:");
	expect(result.content[1].text).toContain("Comparing");
	expect(result.content[1].text).toContain("deadnix:");
	expect(result.content[1].text).toContain("Unused lambda pattern");
	expect(fs.readFileSync(file, "utf8")).toBe(source);
	fs.writeFileSync(path.join(root, "statix.toml"), "[invalid TOML\n");
	const invalidConfig = await handlers.tool_result(event(file), ctx);
	expect(invalidConfig.content[1].text).toContain("statix: check failed");
	expect(invalidConfig.content[1].text).toContain("deadnix:");
});

test("failed edits, reads, and files outside the project do not invoke lint", async () => {
	await handlers.tool_result(event(path.join(root, "a.py"), "edit", true), ctx);
	await handlers.tool_result(event(path.join(root, "a.py"), "read"), ctx);
	await handlers.tool_result(event(path.join(root, "..", "outside.py")), ctx);
	expect(exec).not.toHaveBeenCalled();
});
