import { expect, test } from "bun:test";
import extension, { separateDisplayMath } from "../pi/.pi/agent/extensions/latex-display.ts";

test("separates the reported multiline formula without losing equal signs", () => {
	const source = String.raw`Поэтому в каждом отсчёте:
\[
|g_{k,j}|^2
=
\left|\frac{F_k}{N}\right|^2
\underbrace{|e^{2\pi i kj/N}|^2}_{1}
=
\frac{|F_k|^2}{N^2}.
\]`;
	const rendered = separateDisplayMath(source);
	expect(rendered).toBe(source.replace(":\n", ":\n\n"));
	expect(separateDisplayMath(rendered)).toBe(rendered);
});

test("leaves code, inline math, and existing separators alone", () => {
	for (const source of [
		"```tex\nText:\n\\[\nx=y\n\\]\n```",
		"~~~~tex\nText:\n$$\nx=y\n$$\n~~~~",
		"    \\[\n    x=y\n    \\]",
		"`example\n\\[\nx=y\n\\]\n`",
		String.raw`Use \(x^2\) or $x^2$ inline.`,
		"Text:\n\n\\[\nx=y\n\\]",
	]) expect(separateDisplayMath(source)).toBe(source);
});

test("supports dollar blocks, streaming prefixes, and multiple blocks", () => {
	expect(separateDisplayMath("Text:\n$$\nx=y\n$$")).toBe("Text:\n\n$$\nx=y\n$$");
	expect(separateDisplayMath("Text:\n\\[\nx=")).toBe("Text:\n\n\\[\nx=");
	expect(separateDisplayMath("A\n\\[x=y\\]\nB\n$$a=b$$")).toBe("A\n\n\\[x=y\\]\nB\n\n$$a=b$$");
	for (const [open, close] of [["\\[", "\\]"], ["$$", "$$"]]) {
		const source = `A\n${open}\nx=y${close}\nB\n${open}\nu\n=\nv\n${close}`;
		expect(separateDisplayMath(source)).toBe(source.replace("A\n", "A\n\n").replace("B\n", "B\n\n"));
	}
});

test("registers only a renderer transform, leaving user text and stored messages alone", () => {
	let transform: any;
	extension({ registerMarkdownTransformer: (fn: any) => { transform = fn; } } as any);
	const original = "Text:\n\\[\nx=y\n\\]";
	expect(transform(original, { messageType: "user" })).toBe(original);
	expect(transform(original, { messageType: "assistant" })).toBe("Text:\n\n\\[\nx=y\n\\]");
	expect(original).toBe("Text:\n\\[\nx=y\n\\]");
});

test("literal backticks in prose or indented code do not disable following formulas", () => {
	for (const prefix of ["    `literal\n\nText:", "Escaped \\` tick.\nText:", "Unmatched ` tick.\nText:"]) {
		const source = prefix + "\n\\[\nx\n=\ny\n\\]";
		expect(separateDisplayMath(source)).toBe(prefix + "\n\n\\[\nx\n=\ny\n\\]");
	}
});
