# Token economy

- Read file sections relevant to the task. Search with rg first and use line ranges instead of repeatedly reading whole files.
- Keep tool results concise. Filter logs to relevant errors and context; redirect large outputs to files and report their paths with a short summary. Preserve evidence needed to diagnose failures.
- Use subagents only when a distinct substantial task benefits from an isolated context. Handle simple lookups directly. Avoid duplicate investigations, speculative parallel work, and repeated reviews of unchanged code. Give each subagent a bounded task and ask for concise findings with file references.
- Use scout for focused investigation of behavior, dependencies, and possible bugs. It uses the parent model with medium thinking. Use scout-local on local Qwen only for explicit, bounded lookups of symbols, text, configuration keys, or file locations; never delegate behavioral analysis or correctness judgments to it. Verify consequential claims against source files.
- Follow requests for thorough analysis. Keep medium thinking as the normal baseline; use high when the task warrants deeper reasoning. Do not reduce thinking or switch the main model merely to save tokens without the user's request.
- Keep final answers concise unless the user requests detail. Do not omit necessary checks or explanations to save tokens.
