/**
 * После write/edit запускает линтер по изменённому файлу и добавляет найденные
 * ошибки к результату инструмента. Без автоисправлений, форматирования и
 * дополнительных ходов модели. Настройки линтера берутся из проекта.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DIAGS = 20;
const LINT_TIMEOUT_MS = 15_000;

interface Diag {
	file: string;
	line: number;
	message: string;
}

type Exec = (bin: string, args: string[], timeout: number) => Promise<{ stdout: string; stderr: string; code: number }>;

// Корень рабочей копии (у worktree свой): конфиги линтеров лежат там
function projectRoot(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return cwd;
	}
}

function read(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

const has = (root: string, ...names: string[]) => names.some((n) => fs.existsSync(path.join(root, n)));
const pyproject = (root: string, section: string) => new RegExp(`^\\[tool\\.${section}[\\].]`, "m").test(read(path.join(root, "pyproject.toml")));
const config = {
	ruff: (r: string) => has(r, "ruff.toml", ".ruff.toml") || pyproject(r, "ruff"),
	eslint: (r: string) =>
		has(r, "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"),
};

// Сначала окружение проекта, потом mason (общий том devenv), потом PATH
function findBin(root: string, name: string): string | undefined {
	const dirs = [
		path.join(root, ".venv", "bin"),
		path.join(root, "node_modules", ".bin"),
		path.join(os.homedir(), ".local", "share", "nvim", "mason", "bin"),
		...(process.env.PATH ?? "").split(":"),
	];
	for (const dir of dirs) {
		const bin = path.join(dir, name);
		try {
			fs.accessSync(bin, fs.constants.X_OK);
			return bin;
		} catch {}
	}
	return undefined;
}

const ext = (file: string) => path.extname(file).toLowerCase();
const isPython = (f: string) => ext(f) === ".py" || ext(f) === ".pyi";
const isNix = (f: string) => ext(f) === ".nix";
const isTs = (f: string) => [".ts", ".tsx", ".mts", ".cts"].includes(ext(f));
const isJs = (f: string) => isTs(f) || [".js", ".jsx", ".mjs", ".cjs"].includes(ext(f));
const isShell = (f: string) => [".sh", ".bash"].includes(ext(f)) || /^#!.*\b(ba)?sh\b/.test(read(f).split("\n", 1)[0]);
// "file:line:col: message" — формат ruff concise и shellcheck gcc
function parseLines(out: string, re: RegExp, root: string): Diag[] {
	const diags: Diag[] = [];
	for (const line of out.split("\n")) {
		const m = line.match(re);
		if (m) diags.push({ file: path.resolve(root, m[1]), line: Number(m[2]), message: m[3].trim() });
	}
	return diags;
}
const GCC = /^(.+?):(\d+):\d+: (.+)$/;

// --- линтеры по одному файлу

interface Linter {
	name: string;
	applies: (root: string, file: string) => boolean;
	run: (root: string, file: string, exec: Exec) => Promise<Diag[]>;
}

const LINTERS: Linter[] = [
	{
		name: "statix",
		applies: (_r, f) => isNix(f),
		run: async (r, f, exec) => {
			// errfmt is stable and available even in builds without the JSON feature.
			const out = await exec("statix", ["check", "--format", "errfmt", f], LINT_TIMEOUT_MS);
			// Statix 0.5.8 can report a malformed statix.toml only on stderr,
			// even with exit status 0. Never mistake that for a clean check.
			if (out.stderr.trim() || out.code > 1) throw new Error("statix check failed");
			return parseLines(out.stdout, /^(.+)>(\d+):\d+:([WEI]:\d+:.*)$/, r);
		},
	},
	{
		name: "deadnix",
		applies: (_r, f) => isNix(f),
		run: async (r, f, exec) => {
			// No --edit: unused module arguments can be intentional. Honour upstream
			// deadnix: skip pragmas; report findings without rewriting the source.
			const out = await exec("deadnix", ["--output-format", "json", f], LINT_TIMEOUT_MS);
			const diags: Diag[] = [];
			for (const line of out.stdout.split("\n").filter((s) => s.trim())) {
				const report = JSON.parse(line);
				for (const d of report.results ?? []) {
					diags.push({ file: path.resolve(r, report.file), line: d.line, message: d.message });
				}
			}
			return diags;
		},
	},
	{
		name: "ruff",
		applies: (r, f) => isPython(f) && config.ruff(r),
		run: async (r, f, exec) => parseLines((await exec("ruff", ["check", "--output-format=concise", "--quiet", "--no-fix", f], LINT_TIMEOUT_MS)).stdout, GCC, r),
	},
	{
		name: "shellcheck",
		applies: (_r, f) => isShell(f),
		run: async (r, f, exec) => parseLines((await exec("shellcheck", ["-f", "gcc", "-S", "warning", f], LINT_TIMEOUT_MS)).stdout, GCC, r),
	},
	{
		name: "eslint",
		applies: (r, f) => isJs(f) && config.eslint(r),
		run: async (r, f, exec) => {
			let results: any[];
			try {
				results = JSON.parse((await exec("eslint", ["--format", "json", "--no-fix", f], LINT_TIMEOUT_MS)).stdout);
			} catch {
				return [];
			}
			return results.flatMap((res) =>
				(res.messages ?? [])
					.filter((m: any) => m.severity === 2)
					.map((m: any) => ({ file: res.filePath, line: m.line ?? 0, message: `${m.message}${m.ruleId ? ` (${m.ruleId})` : ""}` })),
			);
		},
	},
];

function format(diags: Diag[], root: string): string {
	const lines = diags.slice(0, MAX_DIAGS).map((d) => `${path.relative(root, d.file)}:${d.line}: ${d.message}`);
	return lines.join("\n") + (diags.length > MAX_DIAGS ? `\n(${diags.length - MAX_DIAGS} more)` : "");
}

export default function (pi: ExtensionAPI) {
	// Не установлен - пропускаем: проверки только помогают, а не мешают работать
	const exec = (root: string): Exec => async (name, args, timeout) => {
		const bin = findBin(root, name);
		if (!bin) return { stdout: "", stderr: "", code: -1 };
		return pi.exec(bin, args, { cwd: root, timeout });
	};

	function inProject(root: string, file: string): boolean {
		return file.startsWith(root + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`);
	}

	function resolve(cwd: string, p: string): string {
		return path.resolve(cwd, p.replace(/^~(?=$|\/)/, os.homedir()));
	}

	// После правки: линтер по файлу
	pi.on("tool_result", async (event, ctx) => {
		if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError) return;
		const root = projectRoot(ctx.cwd);
		const file = resolve(ctx.cwd, (event.input as { path: string }).path);
		if (!inProject(root, file)) return;
		const reports: string[] = [];
		for (const linter of LINTERS) {
			if (!linter.applies(root, file)) continue;
			try {
				const diags = (await linter.run(root, file, exec(root))).filter((d) => d.file === file);
				if (diags.length) reports.push(`${linter.name}:\n${format(diags, root)}`);
			} catch {
				// A broken/malformed linter must not hide the successful edit or stop
				// the other checks. Do not include raw stderr (it may contain secrets).
				reports.push(`${linter.name}: check failed; run the linter manually for details`);
			}
		}
		if (!reports.length) return;
		return { content: [...event.content, { type: "text", text: `\n\nLint errors in this file, fix them:\n${reports.join("\n\n")}` }] };
	});

}
