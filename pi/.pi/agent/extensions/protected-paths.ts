/**
 * Запрет write/edit для файлов, которые агенту трогать незачем: секреты, ключи,
 * внутренности git и окружений, логины и история pi. Путь проверяется по частям
 * абсолютного пути, а не подстрокой: .env.example и .envrc не блокируются.
 * bash не проверяется: команду в общем случае не разобрать
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();

// Каталоги, внутри которых запрещено всё
const DIRS = [".git", "node_modules", ".venv"];
const HOME_DIRS = [".ssh", ".gnupg", ".pi/agent/sessions", ".claude/projects"].map((d) => path.join(HOME, d));
const HOME_FILES = [".pi/agent/auth.json", ".config/devenv/claude.env"].map((f) => path.join(HOME, f));

function reason(file: string): string | undefined {
	const parts = file.split(path.sep);
	const dir = DIRS.find((d) => parts.slice(0, -1).includes(d));
	if (dir) return `inside ${dir}/`;
	const homeDir = HOME_DIRS.find((d) => file.startsWith(d + path.sep));
	if (homeDir) return `inside ${homeDir.replace(HOME, "~")}/`;
	if (HOME_FILES.includes(file)) return "credentials file";

	const name = parts[parts.length - 1];
	if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|template|dist)$/.test(name)) return "environment file with secrets";
	if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || /^id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/.test(name)) return "key file";
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const raw = (event.input as { path: string }).path;
		const file = path.resolve(ctx.cwd, raw.replace(/^~(?=$|\/)/, HOME));
		const why = reason(file);
		if (!why) return;
		if (ctx.hasUI) ctx.ui.notify(`Blocked write to protected path: ${raw} (${why})`, "warning");
		return { block: true, reason: `Path "${raw}" is protected (${why}). Ask the user to change it themselves if it is really needed.` };
	});
}
