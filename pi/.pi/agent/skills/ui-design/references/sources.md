# Upstream research

These are references, not runtime dependencies. The workflow in this skill is written for the existing Pi toolset and does not run third-party scripts or launch another agent.

| Source | Useful pattern | Why not install it for this workflow? |
| --- | --- | --- |
| [Anthropic Frontend Design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | Commit to an aesthetic direction with deliberate typography, spacing and composition. | Design guidance alone doesn't verify the rendered page or match reference geometry. |
| [Impeccable](https://github.com/pbakaus/impeccable), [comp-led workflow](https://github.com/pbakaus/impeccable/blob/main/.pi/skills/impeccable/reference/new-work-comp.md) | Measure mockups by region, compare crops or overlays, then critique and polish. | Full tooling adds setup; for ordinary pages use the existing browser and add an overlay only when useful. |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp), [CLI skill](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/SKILL.md), [visual comparisons](https://playwright.dev/docs/test-snapshots) | Use DOM/snapshots for interaction and screenshots for visual review. Adopt stable regression baselines after approval, not during exploratory matching. | MCP is already available in the target setup; the CLI and a new test dependency aren't prerequisites. |
| [Pi Browser Tools](https://github.com/badlogic/pi-skills/tree/main/browser-tools) | Use a visible browser and element picker when a human wants to point at a region. | Requires a suitable Chrome/debugging setup. Not needed for a headless visual feedback loop. |
