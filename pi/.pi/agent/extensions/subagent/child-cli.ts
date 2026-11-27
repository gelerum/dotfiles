const ACCOUNTS_EXTENSION = "/usr/local/lib/devenv/pi-openai-accounts.ts";

// devenv loads this provider extension via the CLI, not the agent directory.
// Preserve that opt-in when spawning the Pi binary directly. Do not replay
// other -e arguments: they may be relative to the parent's working directory.
export function inheritedAccountArgs(parentArgv: readonly string[]): string[] {
	let enabled = false;
	for (let i = 1; i < parentArgv.length; i++) {
		const arg = parentArgv[i];
		if (arg === "--") break;
		if (arg === "--extension" || arg === "-e") {
			if (parentArgv[++i] === ACCOUNTS_EXTENSION) enabled = true;
		}
	}
	return enabled ? ["--extension", ACCOUNTS_EXTENSION] : [];
}
