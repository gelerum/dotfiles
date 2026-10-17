/**
 * Снимки рабочей копии перед каждым сообщением пользователя, чтобы откатывать правки агента.
 * Снимок - коммит-объект git во временном индексе, ссылка refs/pi-checkpoints/<сессия>/<время>:
 * ветки, HEAD и индекс пользователя не меняются, хуки не запускаются. В снимок идут
 * отслеживаемые и новые файлы без .gitignore, файлы больше MAX_FILE_BYTES - нет (датасеты).
 *
 * /undo - вернуть файлы к последнему снимку, отличному от текущего состояния
 * /redo - отменить последний /undo
 * /checkpoints - выбрать снимок из списка
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const PREFIX = "refs/pi-checkpoints";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_DAYS = 30;

const IDENT = { GIT_AUTHOR_NAME: "pi", GIT_AUTHOR_EMAIL: "pi@localhost", GIT_COMMITTER_NAME: "pi", GIT_COMMITTER_EMAIL: "pi@localhost" };

async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<string> {
	const { stdout } = await run("git", args, { cwd: root, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

async function repoRoot(cwd: string): Promise<string | undefined> {
	try {
		return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return undefined;
	}
}

// Снимок текущего состояния: возвращает коммит. Индекс - копия настоящего, так add -A быстрый
async function snapshot(root: string, subject: string): Promise<string> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckpt-"));
	const index = path.join(tmp, "index");
	try {
		const real = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());
		if (fs.existsSync(real)) fs.copyFileSync(real, index);
		const env = { GIT_INDEX_FILE: index };
		const files = (await git(root, ["ls-files", "-z", "-m", "-d", "-o", "--exclude-standard"], env))
			.split("\0")
			.filter((f) => {
				if (!f) return false;
				try {
					return fs.statSync(path.join(root, f)).size <= MAX_FILE_BYTES;
				} catch {
					return true; // удалённый файл
				}
			});
		if (files.length) {
			const list = path.join(tmp, "paths");
			fs.writeFileSync(list, files.join("\0"));
			await git(root, ["add", "-A", `--pathspec-from-file=${list}`, "--pathspec-file-nul"], env);
		}
		const tree = (await git(root, ["write-tree"], env)).trim();
		let parent: string[] = [];
		try {
			parent = ["-p", (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).trim()];
		} catch {}
		return (await git(root, ["commit-tree", "--no-gpg-sign", tree, ...parent, "-m", subject], IDENT)).trim();
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

interface Checkpoint {
	ref: string;
	commit: string;
	time: number;
	subject: string;
}

// Новые первыми. Порядок - по времени в миллисекундах из имени ссылки: у коммита дата с точностью до секунды
async function list(root: string, prefix: string): Promise<Checkpoint[]> {
	const out = await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents:subject)", prefix]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [ref, commit, time, subject] = l.split("\0");
			const ms = Number(ref.split("/").pop());
			return { ref, commit, time: Number.isFinite(ms) ? ms / 1000 : Number(time), subject };
		})
		.sort((a, b) => b.time - a.time);
}

const treeOf = async (root: string, commit: string) => (await git(root, ["rev-parse", `${commit}^{tree}`])).trim();

// Вернуть рабочую копию к снимку: изменённые и удалённые - из снимка, новые с тех пор - удалить
async function restore(root: string, target: string, current: string): Promise<number> {
	const changes = (await git(root, ["diff", "--name-status", "--no-renames", "-z", target, current]))
		.split("\0")
		.filter(Boolean);
	const added: string[] = [];
	const back: string[] = [];
	for (let i = 0; i + 1 < changes.length; i += 2) (changes[i] === "A" ? added : back).push(changes[i + 1]);
	for (const f of added) fs.rmSync(path.join(root, f), { force: true });
	if (back.length) {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ckpt-"));
		const listFile = path.join(tmp, "paths");
		fs.writeFileSync(listFile, back.join("\0"));
		try {
			await git(root, ["restore", `--source=${target}`, "--worktree", `--pathspec-from-file=${listFile}`, "--pathspec-file-nul"]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}
	return added.length + back.length;
}

const ago = (t: number) => {
	const s = Math.round(Date.now() / 1000 - t);
	return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	const sessionPrefix = (ctx: { sessionManager: { getSessionId(): string } }) => `${PREFIX}/${ctx.sessionManager.getSessionId()}`;

	pi.on("session_start", async (_event, ctx) => {
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const cutoff = Date.now() / 1000 - KEEP_DAYS * 86400;
		for (const c of await list(root, PREFIX).catch(() => [])) {
			if (c.time < cutoff) await git(root, ["update-ref", "-d", c.ref]).catch(() => {});
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		try {
			const prefix = sessionPrefix(ctx);
			const latest = (await list(root, `${prefix}/run`))[0];
			const subject = event.prompt.replace(/\s+/g, " ").slice(0, 80) || "(no prompt)";
			const commit = await snapshot(root, subject);
			// Без новых правок новый снимок не нужен
			if (latest && (await treeOf(root, latest.commit)) === (await treeOf(root, commit))) return;
			await git(root, ["update-ref", `${prefix}/run/${Date.now()}`, commit]);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`checkpoint failed: ${err instanceof Error ? err.message : err}`, "warning");
		}
	});

	async function restoreTo(ctx: ExtensionCommandContext, root: string, target: Checkpoint, label: string): Promise<void> {
		const prefix = sessionPrefix(ctx);
		const current = await snapshot(root, `before ${label}`);
		if ((await treeOf(root, current)) === (await treeOf(root, target.commit))) {
			ctx.ui.notify("Files already match this checkpoint", "info");
			return;
		}
		const ok = await ctx.ui.confirm(`Restore files to checkpoint from ${ago(target.time)}?`, `"${target.subject}"\nUntracked files created since then will be deleted.`);
		if (!ok) return;
		await git(root, ["update-ref", `${prefix}/redo`, current]);
		const n = await restore(root, target.commit, current);
		ctx.ui.notify(`Restored ${n} file(s) to checkpoint "${target.subject}". /redo to undo this`, "info");
	}

	pi.registerCommand("undo", {
		description: "Restore files to the state before the last agent run that changed them",
		handler: async (_args, ctx) => {
			const root = await repoRoot(ctx.cwd);
			if (!root) return ctx.ui.notify("Not a git repository: checkpoints are unavailable", "warning");
			const current = await treeOf(root, await snapshot(root, "current"));
			const all = await list(root, `${sessionPrefix(ctx)}/run`);
			const trees = await Promise.all(all.map((c) => treeOf(root, c.commit)));
			// Повторный /undo идёт дальше в прошлое: от снимка, которому равны текущие файлы
			const at = trees.indexOf(current);
			for (let i = at + 1; i < all.length; i++) {
				if (trees[i] !== current) return restoreTo(ctx, root, all[i], "undo");
			}
			ctx.ui.notify("No checkpoint differs from the current files", "info");
		},
	});

	pi.registerCommand("redo", {
		description: "Revert the last /undo or /checkpoints restore",
		handler: async (_args, ctx) => {
			const root = await repoRoot(ctx.cwd);
			if (!root) return ctx.ui.notify("Not a git repository", "warning");
			const redo = (await list(root, `${sessionPrefix(ctx)}/redo`))[0];
			if (!redo) return ctx.ui.notify("Nothing to redo", "info");
			await restoreTo(ctx, root, { ...redo, subject: "state before the last undo" }, "redo");
		},
	});

	pi.registerCommand("checkpoints", {
		description: "Pick a checkpoint of this session to restore files to",
		handler: async (_args, ctx) => {
			const root = await repoRoot(ctx.cwd);
			if (!root) return ctx.ui.notify("Not a git repository", "warning");
			const all = await list(root, `${sessionPrefix(ctx)}/run`);
			if (!all.length) return ctx.ui.notify("No checkpoints in this session", "info");
			const labels = all.map((c) => `${ago(c.time)}  before: ${c.subject}`);
			const choice = await ctx.ui.select("Restore files to the state before:", labels);
			const picked = all[labels.indexOf(choice ?? "")];
			if (picked) await restoreTo(ctx, root, picked, "restore");
		},
	});
}
