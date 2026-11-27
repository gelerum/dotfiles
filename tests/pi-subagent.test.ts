import { expect, test } from "bun:test";
import { inheritedAccountArgs } from "../pi/.pi/agent/extensions/subagent/child-cli.js";

const accounts = "/usr/local/lib/devenv/pi-openai-accounts.ts";

test("forwards the devenv account extension to the child only once", () => {
	expect(inheritedAccountArgs(["/opt/pi/pi", "--extension", accounts, "-e", accounts, "--model", "openai-codex-account-2/gpt-6.2-sol"]))
		.toEqual(["--extension", accounts]);
});

test("preserves explicit account loading when extension discovery is off", () => {
	expect(inheritedAccountArgs(["pi", "-ne", "-e", accounts])).toEqual(["--extension", accounts]);
});

test("does not inherit other extensions or arguments after the CLI delimiter", () => {
	expect(inheritedAccountArgs(["pi", "-e", "./extension.ts", "--", "--extension", accounts])).toEqual([]);
	expect(inheritedAccountArgs(["pi", "--model", "openai-codex/gpt-6.2-sol"])).toEqual([]);
});
