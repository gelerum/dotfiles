/**
 * Системное уведомление через терминал (OSC 777: Ghostty, WezTerm, iTerm2; OSC 99: Kitty),
 * когда агент закончил долгий запуск или ждёт ответа на вопрос. Быстрые ответы - без
 * уведомления: на них и так смотришь. В tmux нужен allow-passthrough
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTIFY_AFTER_MS = 15_000;

// ; и управляющие символы ломают escape-последовательность
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f;]/g, " ").trim();

function notify(title: string, body: string): void {
	const t = clean(title);
	const b = clean(body);
	if (process.env.KITTY_WINDOW_ID) {
		process.stdout.write(`\x1b]99;i=1:d=0;${t}\x1b\\\x1b]99;i=1:p=body;${b}\x1b\\`);
	} else {
		process.stdout.write(`\x1b]777;notify;${t};${b}\x07`);
	}
}

function lastAssistantText(entries: unknown[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const c = e.message.content;
		const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : "";
		if (text.trim()) return text.trim().split("\n")[0];
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT === "1") return;
	// agent_start бывает несколько раз за запуск (повторы, продолжения) - считаем от первого
	let startedAt: number | undefined;

	pi.on("agent_start", async () => {
		startedAt ??= Date.now();
	});

	pi.on("agent_settled", async (event, ctx) => {
		const took = startedAt === undefined ? 0 : Date.now() - startedAt;
		startedAt = undefined;
		if (!ctx.hasUI || event.aborted || took < NOTIFY_AFTER_MS) return;
		const summary = lastAssistantText(ctx.sessionManager.getBranch()).slice(0, 120);
		notify(`pi: done in ${Math.round(took / 1000)}s`, summary || "Ready for input");
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (ctx.hasUI) notify("pi: waiting for you", event.title ?? "Answer the question in pi");
	});
}
