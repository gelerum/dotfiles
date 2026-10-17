/**
 * Линтер, проверка типов и форматирование для правок модели. Только инструменты, которые
 * настроил сам проект (конфиг в корне), бинарники - из .venv, node_modules, mason или PATH.
 *
 * - после каждого write/edit: линтер по файлу, ошибки дописываются к результату инструмента
 * - в конце запуска, до возврата управления: проверка типов изменённых файлов; новые ошибки
 *   (которых не было до правок) уходят модели, запуск продолжается, не больше FIX_ATTEMPTS раз
 * - затем форматирование изменённых файлов; в следующем запуске модель получает дифф
 *   форматирования (или просьбу перечитать файл, если дифф большой)
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DIAGS = 20;
const FIX_ATTEMPTS = 2;
const MAX_FORMAT_DIFF_LINES = 40;
const LINT_TIMEOUT_MS = 15_000;
const TYPES_TIMEOUT_MS = 120_000;
const FORMAT_TIMEOUT_MS = 30_000;

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
const packageKey = (root: string, key: string) => {
	try {
		return key in JSON.parse(read(path.join(root, "package.json")));
	} catch {
		return false;
	}
};

const config = {
	ruff: (r: string) => has(r, "ruff.toml", ".ruff.toml") || pyproject(r, "ruff"),
	pyright: (r: string) => has(r, "pyrightconfig.json") || pyproject(r, "pyright"),
	mypy: (r: string) => has(r, "mypy.ini", ".mypy.ini") || pyproject(r, "mypy"),
	ts: (r: string) => has(r, "tsconfig.json"),
	eslint: (r: string) =>
		has(r, "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml"),
	prettier: (r: string) =>
		has(r, ".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.js", ".prettierrc.mjs", ".prettierrc.cjs", "prettier.config.js", "prettier.config.mjs", "prettier.config.cjs") ||
		packageKey(r, "prettier"),
	biome: (r: string) => has(r, "biome.json", "biome.jsonc"),
	go: (r: string) => has(r, "go.mod"),
	cargo: (r: string) => has(r, "Cargo.toml"),
	stylua: (r: string) => has(r, "stylua.toml", ".stylua.toml"),
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
const isTs = (f: string) => [".ts", ".tsx", ".mts", ".cts"].includes(ext(f));
const isJs = (f: string) => isTs(f) || [".js", ".jsx", ".mjs", ".cjs"].includes(ext(f));
const isShell = (f: string) => [".sh", ".bash"].includes(ext(f)) || /^#!.*\b(ba)?sh\b/.test(read(f).split("\n", 1)[0]);
const PRETTIER = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".css", ".scss", ".md", ".yaml", ".yml", ".html", ".vue"]);

// "file:line:col: message" - формат gcc, ruff concise, go vet, cargo short
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
				results = JSON.parse((await exec("eslint", ["--format", "json", f], LINT_TIMEOUT_MS)).stdout);
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

// --- проверка типов: per-file или по всему проекту (тогда результат кешируется на запуск)

interface Checker {
	name: string;
	projectWide: boolean;
	applies: (root: string, file: string) => boolean;
	run: (root: string, files: string[], exec: Exec) => Promise<Diag[]>;
}

const CHECKERS: Checker[] = [
	{
		name: "pyright",
		projectWide: false,
		applies: (r, f) => isPython(f) && config.pyright(r),
		run: async (r, files, exec) => {
			const python = path.join(r, ".venv", "bin", "python");
			const args = ["--outputjson", ...(fs.existsSync(python) ? ["--pythonpath", python] : []), ...files];
			try {
				return (JSON.parse((await exec("pyright", args, TYPES_TIMEOUT_MS)).stdout).generalDiagnostics ?? [])
					.filter((d: any) => d.severity === "error")
					.map((d: any) => ({ file: d.file, line: (d.range?.start?.line ?? 0) + 1, message: d.message.split("\n")[0] }));
			} catch {
				return [];
			}
		},
	},
	{
		name: "mypy",
		projectWide: false,
		applies: (r, f) => isPython(f) && !config.pyright(r) && config.mypy(r),
		run: async (r, files, exec) =>
			parseLines(
				(await exec("mypy", ["--no-error-summary", "--show-error-codes", "--no-pretty", "--follow-imports=silent", ...files], TYPES_TIMEOUT_MS)).stdout,
				/^(.+?):(\d+): error: (.+)$/,
				r,
			),
	},
	{
		name: "tsc",
		projectWide: true,
		applies: (r, f) => isTs(f) && config.ts(r),
		run: async (r, _files, exec) =>
			parseLines((await exec("tsc", ["--noEmit", "--pretty", "false", "-p", r], TYPES_TIMEOUT_MS)).stdout, /^(.+?)\((\d+),\d+\): error (.+)$/, r),
	},
	{
		name: "go vet",
		projectWide: false,
		applies: (r, f) => ext(f) === ".go" && config.go(r),
		run: async (r, files, exec) => {
			const pkgs = [...new Set(files.map((f) => "./" + path.relative(r, path.dirname(f))))];
			return parseLines((await exec("go", ["vet", ...pkgs], TYPES_TIMEOUT_MS)).stderr, /^(?:vet: )?(.+?\.go):(\d+):\d+: (.+)$/, r);
		},
	},
	{
		name: "cargo check",
		projectWide: true,
		applies: (r, f) => ext(f) === ".rs" && config.cargo(r),
		run: async (r, _files, exec) =>
			parseLines((await exec("cargo", ["check", "--quiet", "--message-format", "short"], TYPES_TIMEOUT_MS)).stderr, /^(.+?\.rs):(\d+):\d+: (error.*)$/, r),
	},
];

// --- форматтеры: все изменённые файлы одним вызовом

interface Formatter {
	applies: (root: string, file: string) => boolean;
	run: (root: string, files: string[], exec: Exec) => Promise<unknown>;
}

const FORMATTERS: Formatter[] = [
	{ applies: (r, f) => isPython(f) && config.ruff(r), run: (_r, files, exec) => exec("ruff", ["format", "--quiet", ...files], FORMAT_TIMEOUT_MS) },
	{ applies: (r, f) => PRETTIER.has(ext(f)) && config.prettier(r), run: (_r, files, exec) => exec("prettier", ["--write", "--log-level", "warn", ...files], FORMAT_TIMEOUT_MS) },
	{ applies: (r, f) => isJs(f) && !config.prettier(r) && config.biome(r), run: (_r, files, exec) => exec("biome", ["format", "--write", ...files], FORMAT_TIMEOUT_MS) },
	{ applies: (r, f) => ext(f) === ".go" && config.go(r), run: (_r, files, exec) => exec("gofmt", ["-w", ...files], FORMAT_TIMEOUT_MS) },
	{ applies: (r, f) => ext(f) === ".rs" && config.cargo(r), run: (_r, files, exec) => exec("cargo", ["fmt", "--", ...files], FORMAT_TIMEOUT_MS) },
	{ applies: (r, f) => ext(f) === ".lua" && config.stylua(r), run: (_r, files, exec) => exec("stylua", files, FORMAT_TIMEOUT_MS) },
];

function format(diags: Diag[], root: string): string {
	const lines = diags.slice(0, MAX_DIAGS).map((d) => `${path.relative(root, d.file)}:${d.line}: ${d.message}`);
	return lines.join("\n") + (diags.length > MAX_DIAGS ? `\n(${diags.length - MAX_DIAGS} more)` : "");
}

// Без номера строки: после правок строки сдвигаются
const key = (d: Diag) => `${d.file}\0${d.message}`;

export default function (pi: ExtensionAPI) {
	// Не установлен - пропускаем: проверки только помогают, а не мешают работать
	const exec = (root: string): Exec => async (name, args, timeout) => {
		const bin = findBin(root, name);
		if (!bin) return { stdout: "", stderr: "", code: -1 };
		return pi.exec(bin, args, { cwd: root, timeout });
	};

	// Состояние одного запуска (от сообщения пользователя до возврата управления)
	let changed = new Set<string>();
	let baseline = new Map<string, Set<string>>(); // checker -> ошибки до правок
	let baselined = new Set<string>(); // checker\0file, или checker для projectWide
	let attempts = 0;

	function inProject(root: string, file: string): boolean {
		return file.startsWith(root + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`);
	}

	function resolve(cwd: string, p: string): string {
		return path.resolve(cwd, p.replace(/^~(?=$|\/)/, os.homedir()));
	}

	// Заметка о форматировании хранится в сессии, а не в памяти процесса: переживает выход и pi -c
	function pendingNote(ctx: { sessionManager: { getBranch(): unknown[] } }): string | undefined {
		const branch = ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: { note?: string } }[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type !== "custom") continue;
			if (e.customType === "lint-format-sent") return undefined;
			if (e.customType === "lint-format") return e.data?.note;
		}
		return undefined;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType === "user") {
			changed = new Set();
			baseline = new Map();
			baselined = new Set();
			attempts = 0;
		}
		const note = pendingNote(ctx);
		if (!note) return;
		pi.appendEntry("lint-format-sent");
		return { message: { customType: "lint-format", content: note, display: false } };
	});

	// До правки: запомнить ошибки типов, которые уже были
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const root = projectRoot(ctx.cwd);
		const file = resolve(ctx.cwd, (event.input as { path: string }).path);
		if (!inProject(root, file) || !fs.existsSync(file)) return;
		for (const checker of CHECKERS) {
			const id = checker.projectWide ? checker.name : `${checker.name}\0${file}`;
			if (!checker.applies(root, file) || baselined.has(id)) continue;
			baselined.add(id);
			const keys = baseline.get(checker.name) ?? new Set<string>();
			for (const d of await checker.run(root, [file], exec(root))) keys.add(key(d));
			baseline.set(checker.name, keys);
		}
	});

	// После правки: линтер по файлу
	pi.on("tool_result", async (event, ctx) => {
		if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError) return;
		const root = projectRoot(ctx.cwd);
		const file = resolve(ctx.cwd, (event.input as { path: string }).path);
		if (!inProject(root, file)) return;
		changed.add(file);
		const reports: string[] = [];
		for (const linter of LINTERS) {
			if (!linter.applies(root, file)) continue;
			const diags = (await linter.run(root, file, exec(root))).filter((d) => d.file === file);
			if (diags.length) reports.push(`${linter.name}:\n${format(diags, root)}`);
		}
		if (!reports.length) return;
		return { content: [...event.content, { type: "text", text: `\n\nLint errors in this file, fix them:\n${reports.join("\n\n")}` }] };
	});

	// Конец запуска: типы, затем форматирование
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed" || changed.size === 0) return;
		const root = projectRoot(ctx.cwd);
		const files = [...changed].filter((f) => fs.existsSync(f));

		// context.canContinue здесь не смотрим: он false, пока нет нового сообщения; от цикла защищает FIX_ATTEMPTS
		if (attempts < FIX_ATTEMPTS) {
			const reports: string[] = [];
			for (const checker of CHECKERS) {
				const mine = files.filter((f) => checker.applies(root, f));
				if (!mine.length) continue;
				const known = baseline.get(checker.name) ?? new Set<string>();
				const fresh = (await checker.run(root, mine, exec(root))).filter((d) => mine.includes(d.file) && !known.has(key(d)));
				if (fresh.length) reports.push(`${checker.name}:\n${format(fresh, root)}`);
			}
			if (reports.length) {
				attempts++;
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message",
							customType: "typecheck",
							content: `Your changes introduced type errors. Fix them, then finish:\n${reports.join("\n\n")}`,
							display: true,
						},
					],
					continue: true,
				};
			}
		}

		const before = new Map(files.map((f) => [f, read(f)]));
		for (const formatter of FORMATTERS) {
			const mine = files.filter((f) => formatter.applies(root, f));
			if (mine.length) await formatter.run(root, mine, exec(root));
		}
		const diffs: string[] = [];
		const reread: string[] = [];
		for (const [file, old] of before) {
			if (read(file) === old) continue;
			const tmp = path.join(os.tmpdir(), `pi-format-${process.pid}-${path.basename(file)}`);
			fs.writeFileSync(tmp, old);
			const rel = path.relative(root, file);
			const diff = (await pi.exec("diff", ["-u", "--label", `a/${rel}`, "--label", `b/${rel}`, tmp, file])).stdout;
			fs.rmSync(tmp, { force: true });
			if (diff.split("\n").length <= MAX_FORMAT_DIFF_LINES) diffs.push(diff.trim());
			else reread.push(rel);
		}
		if (!diffs.length && !reread.length) return;
		const note =
			"After your last run these files were auto-formatted, so their content differs from what you wrote." +
			(diffs.length ? `\n\n${diffs.join("\n\n")}` : "") +
			(reread.length ? `\n\nRe-read before editing (large formatting changes): ${reread.join(", ")}` : "");
		return { entries: [...event.entries, { type: "custom", customType: "lint-format", data: { note } }] };
	});
}
