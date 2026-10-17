/**
 * Работа с Jupyter-ноутбуками без сырого JSON: модель видит ячейки с номерами, правит одну
 * ячейку за вызов и запускает ноутбук целиком.
 *
 * - notebook_read: ячейки с индексами и id, выводы без base64; картинки - по запросу
 * - notebook_edit: replace/insert/delete ячейки, замена фрагмента внутри ячейки; у изменённой
 *   code-ячейки сбрасываются выводы. Порядок ключей и отступ JSON файла сохраняются
 * - notebook_run: выполнение через nbclient (Run All), выводы пишутся в файл. Python - из
 *   ближайшего .venv, если там есть nbclient и ipykernel, иначе uv run --with ... поверх него
 * - встроенный edit для .ipynb блокируется: правка JSON строками ломает ноутбук
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_OUTPUT_CHARS = 3000; // на один вывод ячейки: начало и конец
const MAX_IMAGES = 8;
const DEFAULT_TIMEOUT_S = 600; // на ячейку
const PY_DEPS = ["nbclient", "nbformat", "ipykernel"];

type CellType = "code" | "markdown" | "raw";
type MultiLine = string | string[];

interface Output {
	output_type: "stream" | "execute_result" | "display_data" | "error" | string;
	name?: string;
	text?: MultiLine;
	data?: Record<string, MultiLine | object>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
}

interface Cell {
	cell_type: CellType;
	id?: string;
	source: MultiLine;
	metadata: Record<string, unknown>;
	outputs?: Output[];
	execution_count?: number | null;
	[key: string]: unknown;
}

interface Notebook {
	cells: Cell[];
	metadata: Record<string, any>;
	nbformat: number;
	nbformat_minor: number;
}

interface Loaded {
	nb: Notebook;
	indent: number;
	trailingNewline: boolean;
}

interface Image {
	type: "image";
	data: string;
	mimeType: string;
}

interface NbDetails {
	path: string;
	summary: string;
	fullOutputPath?: string;
}

// --- формат ---

const join = (s: MultiLine | undefined): string => (Array.isArray(s) ? s.join("") : (s ?? ""));
const splitLines = (s: string): string[] => (s === "" ? [] : s.split(/(?<=\n)/));
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function clip(s: string, max = MAX_OUTPUT_CHARS): string {
	if (s.length <= max) return s;
	const half = Math.floor(max / 2);
	return `${s.slice(0, half)}\n... [${s.length - max} chars omitted] ...\n${s.slice(-half)}`;
}

function resolvePath(cwd: string, p: string): string {
	return path.resolve(cwd, p.replace(/^@/, "").replace(/^~(?=$|\/)/, os.homedir()));
}

function load(file: string): Loaded {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e: any) {
		throw new Error(e.code === "ENOENT" ? `Notebook not found: ${file}` : `Cannot read ${file}: ${e.message}`);
	}
	let nb: Notebook;
	try {
		nb = JSON.parse(raw);
	} catch (e: any) {
		throw new Error(`${file} is not valid JSON: ${e.message}`);
	}
	if (!Array.isArray(nb?.cells)) throw new Error(`${file} has no cells array (nbformat 4 expected)`);
	const indent = raw.match(/^\{\r?\n( +)"/)?.[1].length ?? 1;
	return { nb, indent, trailingNewline: raw.endsWith("\n") };
}

function save(file: string, { nb, indent, trailingNewline }: Loaded): void {
	fs.writeFileSync(file, JSON.stringify(nb, null, indent) + (trailingNewline ? "\n" : ""), "utf8");
}

function emptyNotebook(): Loaded {
	return {
		nb: {
			cells: [],
			metadata: {
				kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
				language_info: { name: "python" },
			},
			nbformat: 4,
			nbformat_minor: 5,
		},
		indent: 1,
		trailingNewline: true,
	};
}

function newCell(nb: Notebook, type: CellType, source: string): Cell {
	// Ключи в алфавитном порядке, как пишет nbformat
	const ordered: Record<string, unknown> = { cell_type: type };
	if (type === "code") ordered.execution_count = null;
	if (nb.nbformat > 4 || (nb.nbformat === 4 && nb.nbformat_minor >= 5)) ordered.id = randomBytes(4).toString("hex");
	ordered.metadata = {};
	if (type === "code") ordered.outputs = [];
	ordered.source = splitLines(source);
	return ordered as Cell;
}

function setType(cell: Cell, type: CellType): void {
	if (cell.cell_type === type) return;
	cell.cell_type = type;
	if (type === "code") {
		delete cell.attachments; // у code-ячеек их нет по схеме nbformat
		cell.execution_count = null;
		cell.outputs = [];
	} else {
		delete cell.execution_count;
		delete cell.outputs;
	}
}

function clearOutputs(cell: Cell): void {
	if (cell.cell_type !== "code") return;
	cell.outputs = [];
	cell.execution_count = null;
}

function header(cell: Cell, i: number): string {
	let h = `# %% [${i}] ${cell.cell_type}`;
	if (cell.id) h += ` id=${cell.id}`;
	if (cell.cell_type === "code" && cell.execution_count != null) h += ` exec=${cell.execution_count}`;
	return h;
}

function renderOutput(out: Output, images: Image[] | undefined): string {
	switch (out.output_type) {
		case "stream":
			return `# >>> ${out.name ?? "stream"}\n${clip(stripAnsi(join(out.text)).replace(/\n$/, ""))}`;
		case "error":
			return `# >>> error: ${out.ename}: ${out.evalue}\n${clip(stripAnsi((out.traceback ?? []).join("\n")))}`;
		case "execute_result":
		case "display_data": {
			const data = out.data ?? {};
			const parts: string[] = [];
			for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
				const b64 = data[mime];
				if (typeof b64 !== "string" && !Array.isArray(b64)) continue;
				if (images && images.length < MAX_IMAGES) {
					images.push({ type: "image", data: join(b64 as MultiLine).replace(/\s/g, ""), mimeType: mime });
					parts.push(`[${mime}: attached image #${images.length}]`);
				} else parts.push(`[${mime} output]`);
			}
			if (data["image/svg+xml"]) parts.push("[image/svg+xml output]");
			// repr вида <IPython.core.display.HTML object> ничего не говорит, берём другой формат
			const plain = data["text/plain"] !== undefined && !/^<[^>]*(object|at 0x[0-9a-f]+)>$/.test(join(data["text/plain"] as MultiLine).trim());
			const text = (plain ? data["text/plain"] : undefined) ?? data["text/markdown"] ?? data["text/latex"];
			if (text !== undefined) parts.push(clip(join(text as MultiLine)));
			else if (data["text/html"]) parts.push(`[text/html]\n${clip(join(data["text/html"] as MultiLine))}`);
			else if (data["application/json"]) parts.push(clip(JSON.stringify(data["application/json"])));
			else if (!parts.length && data["text/plain"] !== undefined) parts.push(join(data["text/plain"] as MultiLine));
			else if (!parts.length) parts.push(`[${Object.keys(data).join(", ") || "empty"} output]`);
			const label = out.output_type === "execute_result" ? "result" : "display";
			return `# >>> ${label}\n${parts.join("\n")}`;
		}
		default:
			return `# >>> ${out.output_type}`;
	}
}

function renderCell(cell: Cell, i: number, opts: { source: boolean; outputs: boolean; images?: Image[] }): string {
	const parts = [header(cell, i)];
	if (opts.source) parts.push(join(cell.source).replace(/\n$/, ""));
	if (opts.outputs && cell.outputs?.length) parts.push(...cell.outputs.map((o) => renderOutput(o, opts.images)));
	return parts.join("\n");
}

function kernelInfo(nb: Notebook): string {
	const k = nb.metadata?.kernelspec?.name;
	const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language;
	return [k && `kernel ${k}`, lang && lang !== k && lang].filter(Boolean).join(", ");
}

// Большой результат: начало модели, целиком - во временный файл
async function finish(text: string, images: Image[], details: NbDetails, hint = "") {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let out = t.content;
	if (t.truncated) {
		const dir = await mkdtemp(path.join(os.tmpdir(), "pi-notebook-"));
		const file = path.join(dir, `${path.basename(details.path, ".ipynb")}.txt`);
		await writeFile(file, text, "utf8");
		details.fullOutputPath = file;
		out +=
			`\n\n[Truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ` +
			`${hint}Full text: ${file}]`;
	}
	return { content: [{ type: "text" as const, text: out }, ...images], details };
}

function findCell(nb: Notebook, index: number | undefined, id: string | undefined): number {
	if (id !== undefined) {
		const i = nb.cells.findIndex((c) => c.id === id);
		if (i < 0) throw new Error(`No cell with id=${id}`);
		if (index !== undefined && index !== i) throw new Error(`Cell id=${id} is at index ${i}, not ${index}`);
		return i;
	}
	if (index === undefined) throw new Error("Pass index or cell_id");
	if (!Number.isInteger(index) || index < 0 || index >= nb.cells.length)
		throw new Error(`Index ${index} out of range: notebook has ${nb.cells.length} cells (0-${nb.cells.length - 1})`);
	return index;
}

// Окрестность правки: модель видит новые индексы, не перечитывая ноутбук
function neighbourhood(nb: Notebook, at: number): string {
	const lines: string[] = [];
	for (let i = Math.max(0, at - 1); i <= Math.min(nb.cells.length - 1, at + 1); i++) {
		const first = join(nb.cells[i].source).split("\n")[0].slice(0, 80);
		lines.push(`${i === at ? ">" : " "} [${i}] ${nb.cells[i].cell_type}${nb.cells[i].id ? ` id=${nb.cells[i].id}` : ""}: ${first}`);
	}
	return lines.join("\n");
}

// --- запуск ---

const RUNNER = String.raw`
import json, os, subprocess, sys, tempfile, time

path, timeout, kernel, allow_errors = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4] == "1"
if kernel == "python3":
    # Установленный в системе kernelspec python3 перекрыл бы этот python: JUPYTER_PATH главнее
    spec = os.path.join(tempfile.mkdtemp(prefix="pi-kernel-"), "kernels", "python3")
    os.makedirs(spec)
    with open(os.path.join(spec, "kernel.json"), "w") as f:
        json.dump({"argv": [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                   "display_name": "Python 3", "language": "python"}, f)
    os.environ["JUPYTER_PATH"] = os.pathsep.join(filter(None, [os.path.dirname(os.path.dirname(spec)), os.environ.get("JUPYTER_PATH")]))

import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError, CellTimeoutError, DeadKernelError

nb = nbformat.read(path, as_version=4)
for c in nb.cells:
    if c.cell_type == "code":
        c.outputs = []
        c.execution_count = None
code = [i for i, c in enumerate(nb.cells) if c.cell_type == "code"]
current = {"i": None}

def start(cell=None, cell_index=None, **kw):
    current["i"] = cell_index
    if cell_index not in code:
        return
    n = code.index(cell_index) + 1
    print(json.dumps({"progress": cell_index, "n": n, "total": len(code)}), file=sys.stderr, flush=True)

client = NotebookClient(nb, timeout=timeout, kernel_name=kernel, allow_errors=allow_errors,
                        resources={"metadata": {"path": __import__("os").path.dirname(path)}})
client.on_cell_start = start
status = {"ok": True}
t0 = time.time()
try:
    # Ядро не держит наши pipe: иначе его фоновые процессы не дали бы дождаться конца
    client.execute(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except CellTimeoutError as e:
    status = {"ok": False, "kind": "timeout", "cell": current["i"], "message": str(e).splitlines()[0] if str(e) else "timeout"}
except CellExecutionError as e:
    status = {"ok": False, "kind": "error", "cell": current["i"], "message": f"{e.ename}: {e.evalue}"}
except DeadKernelError as e:
    status = {"ok": False, "kind": "dead", "cell": current["i"], "message": str(e)}
except Exception as e:
    status = {"ok": False, "kind": "failed", "cell": current["i"], "message": f"{type(e).__name__}: {e}"}
finally:
    nbformat.write(nb, path)
status["seconds"] = round(time.time() - t0, 1)
print(json.dumps(status), flush=True)
`;

function findVenvPython(from: string): string | undefined {
	for (let dir = from; ; dir = path.dirname(dir)) {
		const py = path.join(dir, ".venv", "bin", "python");
		if (fs.existsSync(py)) return py;
		if (dir === path.dirname(dir)) return undefined;
	}
}

const execFileP = promisify(execFile);
const succeeds = (cmd: string, args: string[], signal?: AbortSignal) =>
	execFileP(cmd, args, { timeout: 30_000, signal }).then(
		() => true,
		() => false,
	);
const hasDeps = (python: string, signal?: AbortSignal) => succeeds(python, ["-c", `import ${PY_DEPS.join(", ")}`], signal);
const onPath = (bin: string) => succeeds("sh", ["-c", `command -v ${bin}`]);

// Команда запуска: python окружения проекта, где есть всё нужное, иначе uv поверх него.
// --no-project: uv не создаёт и не синхронизирует .venv проекта как побочный эффект
async function runnerCommand(dir: string, signal?: AbortSignal): Promise<{ cmd: string; args: string[]; via: string }> {
	const venv = findVenvPython(dir);
	if (venv && (await hasDeps(venv, signal))) return { cmd: venv, args: [], via: venv };
	if (await onPath("uv")) {
		const args = ["run", "--quiet", "--no-project", ...PY_DEPS.flatMap((d) => ["--with", d])];
		if (venv) args.push("--python", venv);
		args.push("python");
		return { cmd: "uv", args, via: `uv run --with ${PY_DEPS.join(",")}${venv ? ` on ${venv}` : ""}` };
	}
	if (!venv && (await hasDeps("python3", signal))) return { cmd: "python3", args: [], via: "python3" };
	throw new Error(`Cannot run notebook: need python with ${PY_DEPS.join(", ")} (in .venv or PATH) or uv`);
}

interface RunStatus {
	ok: boolean;
	kind?: string;
	cell?: number | null;
	message?: string;
	seconds?: number;
}

function execRunner(
	command: { cmd: string; args: string[] },
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: (n: number, total: number, cell: number) => void,
): Promise<{ status?: RunStatus; stderr: string; code: number | null }> {
	if (signal?.aborted) return Promise.reject(new Error("Notebook run aborted"));
	return new Promise((resolve, reject) => {
		// Своя группа процессов; ядро в своей сессии, но завершается вслед за родителем
		const child = spawn(command.cmd, [...command.args, "-c", RUNNER, ...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let buf = "";
		const kill = () => {
			try {
				process.kill(-child.pid!, "SIGTERM");
			} catch {}
			child.stdout.destroy();
			child.stderr.destroy();
			reject(new Error("Notebook run aborted"));
		};
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => {
			buf += d;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				try {
					const p = JSON.parse(line);
					if (typeof p.progress === "number") {
						onProgress(p.n, p.total, p.progress);
						continue;
					}
				} catch {}
				// Шум ipykernel, не относящийся к ноутбуку
				if (/^\[IPKernelApp\] WARNING \| Kernel is running over TCP/.test(line)) continue;
				stderr += line + "\n";
			}
		});
		child.on("error", reject);
		// exit, а не close: pipe мог унаследовать кто-то ещё, ждать его незачем
		child.on("exit", (code) => {
			signal?.removeEventListener("abort", kill);
			if (signal?.aborted) return;
			const last = stdout.trim().split("\n").pop();
			let status: RunStatus | undefined;
			try {
				status = last ? JSON.parse(last) : undefined;
			} catch {}
			resolve({ status, stderr: stderr + buf, code });
		});
	});
}

// --- отображение в TUI ---

function renderNbResult(result: any, expanded: boolean, theme: any) {
	const d = result.details as NbDetails | undefined;
	const first = result.content?.find((c: any) => c.type === "text")?.text ?? "";
	let text = theme.fg(result.isError ? "error" : "muted", d?.summary ?? first.split("\n")[0]);
	if (d?.fullOutputPath) text += theme.fg("warning", " (truncated)");
	if (expanded) {
		const lines = first.split("\n").slice(0, 40);
		text += "\n" + lines.map((l: string) => theme.fg("dim", l)).join("\n");
		if (first.split("\n").length > 40) text += `\n${theme.fg("muted", "...")}`;
	}
	return new Text(text, 0, 0);
}

const callLine = (theme: any, name: string, rest: string) => new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", rest), 0, 0);

// --- инструменты ---

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "edit") return;
		const p = (event.input as { path?: string }).path ?? "";
		if (/\.ipynb$/i.test(p)) return { block: true, reason: "Use notebook_edit for .ipynb files: editing notebook JSON as text breaks it" };
	});

	pi.registerTool({
		name: "notebook_read",
		label: "Notebook read",
		description:
			"Read a Jupyter notebook (.ipynb) as cells: '# %% [index] type id=... exec=N' header, source, then outputs ('# >>> stdout', '# >>> result', '# >>> error'). " +
			"Base64 images are omitted unless images=true, long outputs are clipped. Indices are 0-based and are what notebook_edit takes.",
		promptSnippet: "notebook_read: Read a Jupyter notebook as numbered cells with outputs",
		promptGuidelines: [
			"For .ipynb files use notebook_read, notebook_edit and notebook_run instead of read/edit/write: raw notebook JSON is noisy and easy to break",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .ipynb file" }),
			start: Type.Optional(Type.Integer({ minimum: 0, description: "First cell index (default 0)" })),
			end: Type.Optional(Type.Integer({ minimum: 0, description: "Last cell index, inclusive (default: last cell)" })),
			outputs: Type.Optional(Type.Boolean({ description: "Include cell outputs (default true)" })),
			images: Type.Optional(Type.Boolean({ description: `Attach image outputs, up to ${MAX_IMAGES} (default false)` })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolvePath(ctx.cwd, params.path);
			const { nb } = load(file);
			const n = nb.cells.length;
			const start = params.start ?? 0;
			const end = Math.min(params.end ?? n - 1, n - 1);
			const images: Image[] | undefined = params.images ? [] : undefined;
			const cells: string[] = [];
			for (let i = start; i <= end; i++) cells.push(renderCell(nb.cells[i], i, { source: true, outputs: params.outputs !== false, images }));
			const range = start > 0 || end < n - 1 ? `, showing ${start}-${end}` : "";
			const head = `${params.path}: ${n} cells${kernelInfo(nb) ? ` (${kernelInfo(nb)})` : ""}${range}`;
			const body = n === 0 ? "(empty notebook)" : cells.length ? cells.join("\n\n") : `(no cells in range ${start}-${end})`;
			return finish(`${head}\n\n${body}`, images ?? [], { path: file, summary: head }, "Use start/end to read fewer cells. ");
		},
		renderCall(args, theme) {
			const range = args.start !== undefined || args.end !== undefined ? ` [${args.start ?? 0}:${args.end ?? ""}]` : "";
			return callLine(theme, "notebook_read", `${args.path ?? ""}${range}`);
		},
		renderResult: (result, { expanded }, theme) => renderNbResult(result, expanded, theme),
	});

	pi.registerTool({
		name: "notebook_edit",
		label: "Notebook edit",
		description:
			"Edit one cell of a Jupyter notebook. action=replace (default): set the cell's full source, or swap old_text for new_text inside it (old_text must occur once); " +
			"cell_type converts the cell. action=insert: add a cell at index (default: append), or after cell_id; creates the notebook if the file does not exist. " +
			"action=delete: remove the cell. Address cells by 0-based index from notebook_read or by cell_id (stable across inserts). " +
			"Changing a code cell clears its outputs. Returns the new indices around the edit.",
		promptSnippet: "notebook_edit: Replace, insert or delete a Jupyter notebook cell",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .ipynb file" }),
			action: Type.Optional(StringEnum(["replace", "insert", "delete"] as const, { description: "Default replace" })),
			index: Type.Optional(Type.Integer({ minimum: 0, description: "0-based cell index" })),
			cell_id: Type.Optional(Type.String({ description: "Cell id, alternative to index; for insert, the new cell goes after it" })),
			source: Type.Optional(Type.String({ description: "Full new cell source (replace, insert)" })),
			old_text: Type.Optional(Type.String({ description: "Exact text to replace inside the cell (replace)" })),
			new_text: Type.Optional(Type.String({ description: "Replacement for old_text" })),
			cell_type: Type.Optional(StringEnum(["code", "markdown", "raw"] as const, { description: "Cell type; insert defaults to code" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const file = resolvePath(ctx.cwd, params.path);
			const action = params.action ?? "replace";
			return withFileMutationQueue(file, async () => {
				let loaded: Loaded;
				let created = false;
				if (action === "insert" && !fs.existsSync(file)) {
					if (!file.endsWith(".ipynb")) throw new Error("New notebook path must end with .ipynb");
					fs.mkdirSync(path.dirname(file), { recursive: true });
					loaded = emptyNotebook();
					created = true;
				} else loaded = load(file);
				const { nb } = loaded;
				let at: number;
				let msg: string;

				if (action === "insert") {
					if (params.source === undefined) throw new Error("insert needs source");
					if (params.cell_id !== undefined && params.index !== undefined) throw new Error("insert takes index or cell_id, not both");
					if (params.cell_id !== undefined) at = findCell(nb, undefined, params.cell_id) + 1;
					else at = params.index ?? nb.cells.length;
					if (at > nb.cells.length) throw new Error(`Index ${at} out of range: notebook has ${nb.cells.length} cells`);
					const cell = newCell(nb, params.cell_type ?? "code", params.source);
					nb.cells.splice(at, 0, cell);
					msg = `${created ? `Created ${params.path}, inserted` : "Inserted"} ${cell.cell_type} cell [${at}]${cell.id ? ` id=${cell.id}` : ""}`;
				} else if (action === "delete") {
					at = findCell(nb, params.index, params.cell_id);
					const [cell] = nb.cells.splice(at, 1);
					msg = `Deleted ${cell.cell_type} cell [${at}]${cell.id ? ` id=${cell.id}` : ""}; later cells shifted up by one`;
					at = Math.min(at, nb.cells.length - 1);
				} else {
					at = findCell(nb, params.index, params.cell_id);
					const cell = nb.cells[at];
					const before = join(cell.source);
					let after = before;
					if (params.old_text !== undefined) {
						if (params.source !== undefined) throw new Error("Pass either source or old_text/new_text, not both");
						if (params.new_text === undefined) throw new Error("old_text needs new_text");
						if (params.old_text === "") throw new Error("old_text is empty");
						const count = before.split(params.old_text).length - 1;
						if (count === 0) throw new Error(`old_text not found in cell [${at}]`);
						if (count > 1) throw new Error(`old_text occurs ${count} times in cell [${at}]; add context to make it unique`);
						after = before.replace(params.old_text, () => params.new_text!);
					} else if (params.source !== undefined) after = params.source;
					else if (!params.cell_type) throw new Error("replace needs source, old_text/new_text or cell_type");
					const typeChanged = params.cell_type !== undefined && params.cell_type !== cell.cell_type;
					if (after === before && !typeChanged) throw new Error("No change: new source equals the current one");
					if (params.cell_type) setType(cell, params.cell_type);
					cell.source = splitLines(after);
					clearOutputs(cell);
					msg = `Updated ${cell.cell_type} cell [${at}]${cell.id ? ` id=${cell.id}` : ""}${cell.cell_type === "code" ? ", outputs cleared" : ""}`;
				}

				save(file, loaded);
				const around = nb.cells.length ? `\n${neighbourhood(nb, at)}` : "\n(notebook is now empty)";
				return { content: [{ type: "text" as const, text: `${msg}. ${nb.cells.length} cells.${around}` }], details: { path: file, summary: msg } as NbDetails };
			});
		},
		renderCall(args, theme) {
			const where = args.cell_id ? `id=${args.cell_id}` : args.index !== undefined ? `[${args.index}]` : "";
			return callLine(theme, "notebook_edit", `${args.action ?? "replace"} ${args.path ?? ""} ${where}`.trimEnd());
		},
		renderResult: (result, { expanded }, theme) => renderNbResult(result, expanded, theme),
	});

	pi.registerTool({
		name: "notebook_run",
		label: "Notebook run",
		description:
			"Execute a Jupyter notebook top to bottom in a fresh kernel (like Restart & Run All) and save outputs into the file. " +
			"Stops at the first failing cell unless allow_errors=true. Returns the outputs of code cells and the source of the failing cell. " +
			`Uses the nearest .venv python (needs ${PY_DEPS.join(", ")}) or uv run --with them on top of it; the kernel runs in the notebook's directory. The notebook's kernelspec metadata is ignored unless kernel is set.`,
		promptSnippet: "notebook_run: Execute a Jupyter notebook and get cell outputs and errors",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .ipynb file" }),
			timeout: Type.Optional(Type.Integer({ minimum: 1, description: `Per-cell timeout, seconds (default ${DEFAULT_TIMEOUT_S})` })),
			allow_errors: Type.Optional(Type.Boolean({ description: "Keep running after a failing cell (default false)" })),
			kernel: Type.Optional(Type.String({ description: "Kernel name (default python3, the python running the notebook)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const file = resolvePath(ctx.cwd, params.path);
			load(file); // проверка до запуска ядра
			const dir = path.dirname(file);
			const command = await runnerCommand(dir, signal);
			const args = [file, String(params.timeout ?? DEFAULT_TIMEOUT_S), params.kernel ?? "python3", params.allow_errors ? "1" : "0"];
			const { status, stderr, code } = await withFileMutationQueue(file, async () =>
				execRunner(command, args, dir, signal, (n, total, cell) =>
					onUpdate?.({ content: [{ type: "text", text: `Running cell [${cell}] (${n}/${total})` }], details: { path: file, summary: `running ${n}/${total}` } }),
				),
			);
			if (!status) throw new Error(`Notebook runner failed (exit ${code}, via ${command.via}):\n${clip(stripAnsi(stderr), 4000)}`);

			const { nb } = load(file);
			const failed = status.ok ? undefined : (status.cell ?? undefined);
			const errorCells = nb.cells.flatMap((c, i) => (c.outputs?.some((o) => o.output_type === "error") ? [i] : []));
			let summary: string;
			if (status.ok) summary = `Ran ${params.path} in ${status.seconds}s${errorCells.length ? `, errors in cells ${errorCells.join(", ")}` : ", no errors"}`;
			else summary = `Stopped${failed !== undefined ? ` at cell [${failed}]` : ""} (${status.kind}) after ${status.seconds}s: ${status.message}`;

			const cells: string[] = [];
			nb.cells.forEach((c, i) => {
				if (c.cell_type !== "code") return;
				const failedHere = i === failed || errorCells.includes(i);
				if (!c.outputs?.length && !failedHere) return;
				cells.push(renderCell(c, i, { source: failedHere, outputs: true }));
			});
			// stderr ядра нужен, только когда упало само ядро; вывод ячеек уже в outputs
			const notes = (status.kind === "dead" || status.kind === "failed") && stderr.trim() ? `\n\n[runner stderr]\n${clip(stripAnsi(stderr.trim()), 2000)}` : "";
			const body = cells.length ? cells.join("\n\n") : "(no outputs)";
			const res = await finish(`${summary}\n\n${body}${notes}`, [], { path: file, summary });
			return status.ok && !errorCells.length ? res : { ...res, isError: true };
		},
		renderCall(args, theme) {
			return callLine(theme, "notebook_run", args.path ?? "");
		},
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (isPartial) return new Text(theme.fg("warning", (result.details as NbDetails | undefined)?.summary ?? "running..."), 0, 0);
			return renderNbResult(result, expanded, theme);
		},
	});
}
