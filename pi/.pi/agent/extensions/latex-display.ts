/**
 * Pi 1.3.0 can parse a display formula as part of the preceding paragraph:
 * a standalone '=' then becomes a Markdown heading and disappears. Separate
 * display blocks in the renderer only. Session text and LLM context stay intact.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function closesMath(line: string, math: "bracket" | "dollar"): boolean {
	const text = line.trimEnd();
	const delimiter = math === "bracket" ? "\\]" : "$$";
	if (!text.endsWith(delimiter)) return false;
	let slashes = 0;
	for (let i = text.length - delimiter.length - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 0;
}

export function separateDisplayMath(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let fence: { char: string; length: number } | undefined;
	let inlineTicks = 0;
	let math: "bracket" | "dollar" | undefined;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (!line.trim()) inlineTicks = 0; // Code spans cannot cross a paragraph boundary.
		if (math) {
			output.push(line);
			if (closesMath(line, math)) math = undefined;
			continue;
		}
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			output.push(line);
			if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
			continue;
		}
		if (!inlineTicks && marker) {
			fence = { char: marker[1][0], length: marker[1].length };
			output.push(line);
			continue;
		}
		// Four-space indentation is a code block, not display math.
		if (!inlineTicks && /^ {4}|^\t/.test(line)) {
			output.push(line);
			continue;
		}
		if (!inlineTicks) {
			const bracket = /^ {0,3}\\\[/.test(line);
			const dollar = /^ {0,3}\$\$/.test(line);
			if (bracket || dollar) {
				if (output.length && output[output.length - 1].trim()) output.push("");
				output.push(line);
				const closed = closesMath(line.replace(/^ {0,3}(?:\\\[|\$\$)/, ""), bracket ? "bracket" : "dollar");
				if (!closed) math = bracket ? "bracket" : "dollar";
				continue;
			}
		}
		for (const ticks of line.matchAll(/`+/g)) {
			if (!inlineTicks) {
				let slashes = 0;
				for (let i = ticks.index! - 1; i >= 0 && line[i] === "\\"; i--) slashes++;
				if (slashes % 2) continue;
				// An unmatched backtick is literal Markdown, not a code span.
				let rest = line.slice(ticks.index! + ticks[0].length);
				for (let i = lineIndex + 1; i < lines.length && lines[i].trim(); i++) rest += "\n" + lines[i];
				if ([...rest.matchAll(/`+/g)].some((close) => close[0].length === ticks[0].length)) inlineTicks = ticks[0].length;
			}
			else if (inlineTicks === ticks[0].length) inlineTicks = 0;
		}
		output.push(line);
	}
	return output.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant" || context.messageType === "assistant-thinking"
			? separateDisplayMath(markdown) : markdown,
	);
}
