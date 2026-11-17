# Pi chat UI

`pi/.pi/agent/extensions/chat-ui.ts` provides compact tool output and quote replies.
All controls and labels are in English. It requires pi 1.5.x; native terminal tests
have exercised both 1.5.0 and 1.5.2.

## Controls

| Action | Control |
|---|---|
| Quote the selected transcript text | Select with the mouse, then **Alt+Q** |
| Quote without a mouse selection | **Alt+Q** or `/quote`: choose a reply, then keep the desired excerpt |
| Pick exact Markdown/LaTeX source, ignoring mouse selection | `/quote --pick` |
| Insert a manually supplied quote | `/quote exact text` |
| Compact tool output | `/ui compact` (the default) |
| Full tool arguments and output | **Ctrl+O**, click a tool row, or `/ui verbose` |
| Inspect current output mode | `/ui` |

Quotes are inserted into the input editor, **not sent automatically**. Existing
draft text is preserved below the quote. Cancelling a picker leaves the draft
unchanged. The fallback editor accepts an unchanged, contiguous excerpt, not a
rewritten paraphrase. Quotes over 20,000 characters are rejected rather than
silently truncated. Only the current branch's last 20 textual assistant replies
are offered; thinking blocks and tool calls are not offered as replies.

Native mouse selection requires fullscreen mode (`"tuiMode": "fullscreen"` in
pi settings). In regular mode, the terminal owns mouse selection, so use the
reply/excerpt picker or a manual quote instead. If you do not want pi itself to
copy selected text to the OS clipboard, set `"fullscreenCopyOnSelect": false`.
The quote implementation never reads the OS clipboard and needs no Wayland/X11
socket, including in containers or over SSH. Alt+Q may conflict with the default
queued-message shortcut on Windows/WSL; `/quote` remains available there.

## Compact display

Collapsed tools show a single status line with a tool name, a path where useful,
a small result summary and duration. Shell commands, prompts, queries and logs
are not dumped into collapsed headers. Failures and lint findings retain a
bounded three-line preview with a detail-expansion hint. Streaming calls are not
marked as successful. Questionnaires and the task list keep their original
renderers.

Expanded rows delegate to the tool's original renderers, preserving formatted
diffs and custom output. Tools without custom renderers fall back to full JSON
arguments and all text blocks. Inline image handling remains pi's own behavior.
The extension never overrides tool execution or rewrites `tool_result` data:
model context, saved session results, exit/error status and output artifacts
remain unchanged. "Full" means the original tool result; tools may themselves
truncate large output and save the remainder in an artifact file.

The `/ui` preference is saved as a non-model-facing session entry and restored on
reload/resume. It is not a global setting. Progress narration is also kept sparse
by the shared agent instructions; rendering cannot remove prose the assistant
chooses to write.

## Selection compatibility

Pi's public `ExtensionUIContext` does not expose selected transcript text. The
extension obtains the real renderer through an invisible widget factory, then
feature-detects the `getActiveSelectionText()` method of fullscreen TUI. That
method is **private upstream**, so this is a deliberately narrow compatibility
bridge, not a supported cross-version API guarantee. It reads only the selected
text and does not inspect coordinates or patch core objects. Native selection
returns rendered text, including visual line wraps, not the original Markdown
source. Use `/quote --pick` when preserving exact Markdown or LaTeX source
matters. If the accessor is absent or throwing, quoting falls back to
that picker.

Run the native test before upgrading pi. It starts an isolated PTY with a fake
saved conversation, checks compact/expanded output and visible errors, resizes
the terminal, selects an exact excerpt with mouse events and presses Alt+Q. It
asserts that the quote and existing draft both survive. No model request or
provider credential is used.

## Load and test

The published devenv image includes this extension through the pinned
`DOTFILES_REF` in `devenv/Dockerfile`. Publish the dotfiles commit first, then
update that pin and publish a new devenv image. Uncommitted changes are never
included in GitHub builds.

On the laptop, pull the new image and recreate the container using the normal
project launcher after saving active work. No dotfiles bind mount is required.

Use `/ui` as a quick activation check. If pi reports an unknown command, the
extension is not loaded and Alt+Q cannot work. Check the actual discovery path:

```sh
readlink -f "$PI_CODING_AGENT_DIR/extensions/chat-ui.ts"
```

For local development only, load the source explicitly with
`pi -e ~/2_Code/dotfiles/pi/.pi/agent/extensions/chat-ui.ts`. Do not load a second
copy when the image already discovers it automatically.

From the dotfiles checkout:

```sh
# Tests use a lightweight terminal mock; no installed pi is required.
env -u PI_MEMORY bun test tests

# Real mouse-selection/rendering test. Does not send prompts to a model.
PI_TEST_BINARY=/opt/pi/pi python3 -m unittest discover -s tests -p test_pi_chat_ui.py -v

# After installing extension dev dependencies (pi-coding-agent and pi-tui 1.5.2):
cd pi/.pi/agent/extensions
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext \
  --moduleResolution bundler chat-ui.ts
```

Unsetting `PI_MEMORY` is only for the legacy memory extension's unit tests; keep
its normal Hindsight-controlled setting when running pi itself.
