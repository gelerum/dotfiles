"""Optional native TUI test: PI_TEST_BINARY=/opt/pi/pi python3 -m unittest discover -s tests -p test_pi_chat_ui.py -v.

Uses a fake saved conversation and terminal input only. No provider credentials,
network requests, OS clipboard, or model calls are needed.
"""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest
import fcntl

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('PI_TEST_BINARY'), 'set PI_TEST_BINARY for the native terminal test')
class ChatUITerminalTests(unittest.TestCase):
    def test_compact_expansion_and_mouse_selection_quote_preserve_draft(self):
        with tempfile.TemporaryDirectory(prefix='pi-chat-ui-test-') as tmp:
            root = Path(tmp)
            agent = root / 'agent'
            agent.mkdir()
            # Exercise automatic discovery, not only an explicit CLI -e override.
            (agent / 'extensions').mkdir()
            (agent / 'extensions/chat-ui.ts').symlink_to(ROOT / 'pi/.pi/agent/extensions/chat-ui.ts')
            (agent / 'settings.json').write_text(json.dumps({
                'tuiMode': 'fullscreen', 'fullscreenCopyOnSelect': False,
                'quietStartup': True, 'compaction': {'enabled': False},
            }))
            screen = root / 'screen.json'
            state = root / 'state.json'
            probe = root / 'probe.ts'
            probe.write_text('''
import { writeFileSync } from 'node:fs';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
export default function(pi) {
  let host;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('test-probe', (tui) => {
      host = tui;
      return { render: () => [], invalidate() {} };
    });
  });
  pi.registerCommand('ux-screen', { handler: async () => {
    writeFileSync(process.env.UX_SCREEN, JSON.stringify(host.getScreenLines().map(stripTerminalSequences)));
  }});
  pi.registerShortcut('alt+w', { description: 'Test probe', handler: async (ctx) => {
    writeFileSync(process.env.UX_STATE, JSON.stringify({ draft: ctx.ui.getEditorText() }));
  }});
}
''')
            session = root / 'fixture.jsonl'
            now = '2026-01-01T00:00:00.000Z'
            records = [{'type': 'session', 'version': 3, 'id': 'chat-ui-fixture', 'timestamp': now, 'cwd': tmp}]
            parent = None

            def message(value):
                nonlocal parent
                ident = f'{len(records):08x}'
                records.append({'type': 'message', 'id': ident, 'parentId': parent, 'timestamp': now,
                                'message': {**value, 'timestamp': 1767225600000}})
                parent = ident

            def assistant(content, stop='stop'):
                message({'role': 'assistant', 'content': content, 'api': 'openai-responses',
                         'provider': 'openai', 'model': 'gpt-4o', 'stopReason': stop,
                         'usage': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0,
                                   'totalTokens': 0, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0,
                                                             'cacheWrite': 0, 'total': 0}}})

            message({'role': 'user', 'content': 'UI smoke test only'})
            assistant([{'type': 'toolCall', 'id': 'shell-1', 'name': 'bash',
                        'arguments': {'command': 'echo COMMAND_MARKER'}}], 'toolUse')
            message({'role': 'toolResult', 'toolName': 'bash', 'toolCallId': 'shell-1',
                     'content': [{'type': 'text', 'text': 'OUTPUT_MARKER\nSuccess details'}], 'isError': False})
            assistant([{'type': 'toolCall', 'id': 'shell-2', 'name': 'bash',
                        'arguments': {'command': 'echo FAILED_COMMAND'}}], 'toolUse')
            message({'role': 'toolResult', 'toolName': 'bash', 'toolCallId': 'shell-2',
                     'content': [{'type': 'text', 'text': 'EXPECTED_FAILURE'}], 'isError': True})
            for tool in ('edit', 'write'):
                assistant([{'type': 'toolCall', 'id': f'{tool}-lint', 'name': tool,
                            'arguments': {'path': 'fixture.nix', 'content': '{}',
                                          'edits': [{'oldText': 'old', 'newText': 'new'}]}}], 'toolUse')
                findings = '\n'.join(f'{tool.upper()}_LINT_{i}' for i in range(1, 5))
                message({'role': 'toolResult', 'toolName': tool, 'toolCallId': f'{tool}-lint',
                         'content': [{'type': 'text', 'text': f'Applied\n\nLint errors in this file, fix them:\nstatix:\n{findings}'}],
                         'details': {'diff': '-1 old\n+1 DIFF_MARKER'} if tool == 'edit' else {}, 'isError': False})
            assistant([{'type': 'text', 'text': 'Unicode: α + β = 1 · 漢字\n\nQuote target: ALPHA BETA\n\nUse a precise excerpt.'}])
            session.write_text('\n'.join(json.dumps(row) for row in records) + '\n')
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 72, 110, 0, 0))
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(('PI_', 'OPENAI_', 'ANTHROPIC_', 'HINDSIGHT_'))}
            env.update(HOME=tmp, TERM='xterm-256color', PI_CODING_AGENT_DIR=str(agent),
                       PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0', UX_SCREEN=str(screen), UX_STATE=str(state))
            binary = shutil.which(os.environ['PI_TEST_BINARY']) or os.environ['PI_TEST_BINARY']
            process = subprocess.Popen([
                binary, '--no-skills', '--no-prompt-templates', '--no-mcp', '-e', str(probe),
                '--session', str(session),
            ], stdin=slave, stdout=slave, stderr=slave, cwd=tmp, env=env, start_new_session=True)
            os.close(slave)
            transcript = bytearray()

            def drain(seconds=0.4):
                end = time.monotonic() + seconds
                while time.monotonic() < end:
                    if select.select([master], [], [], 0.05)[0]:
                        try:
                            data = os.read(master, 65536)
                        except OSError:
                            break
                        if not data:
                            break
                        transcript.extend(data)

            def send(data):
                os.write(master, data)
                drain()

            def wait_file(file):
                deadline = time.monotonic() + 12
                while not file.exists() and time.monotonic() < deadline:
                    drain(0.1)
                    if process.poll() is not None:
                        break
                self.assertTrue(file.exists(), transcript.decode(errors='replace')[-6000:])
                return json.loads(file.read_text())

            def snapshot():
                screen.unlink(missing_ok=True)
                send(b'/ux-screen\r')
                return wait_file(screen)

            try:
                drain(2)
                collapsed = snapshot()
                self.assertNotIn('COMMAND_MARKER', '\n'.join(collapsed))
                self.assertNotIn('OUTPUT_MARKER', '\n'.join(collapsed))
                self.assertIn('EXPECTED_FAILURE', '\n'.join(collapsed))
                self.assertIn('EDIT_LINT_1', '\n'.join(collapsed))
                self.assertNotIn('EDIT_LINT_4', '\n'.join(collapsed))
                send(b'\x0f')  # Ctrl+O
                expanded = snapshot()
                self.assertIn('COMMAND_MARKER', '\n'.join(expanded))
                self.assertIn('OUTPUT_MARKER', '\n'.join(expanded))
                self.assertIn('DIFF_MARKER', '\n'.join(expanded))
                for tool in ('EDIT', 'WRITE'):
                    self.assertIn(f'{tool}_LINT_4', '\n'.join(expanded))
                send(b'\x0f')
                send(b'/ui verbose\r')
                verbose = '\n'.join(snapshot())
                for tool in ('EDIT', 'WRITE'):
                    self.assertIn(f'{tool}_LINT_4', verbose)
                send(b'/ui compact\r')
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 72, 48, 0, 0))
                os.killpg(process.pid, signal.SIGWINCH)
                drain()
                lines = snapshot()
                self.assertNotIn('OUTPUT_MARKER', '\n'.join(lines))
                index = next(i for i, line in enumerate(lines) if 'Quote target: ALPHA BETA' in line)
                column = lines[index].index('ALPHA BETA') + 1
                send(b'Follow-up question')
                # SGR mouse: press, drag to final character, release. Native
                # fullscreen selection is read directly, not through clipboard.
                row = index + 1
                send(f'\x1b[<0;{column};{row}M'.encode())
                send(f'\x1b[<32;{column + 9};{row}M'.encode())
                send(f'\x1b[<0;{column + 9};{row}m'.encode())
                send(b'\x1bq')  # Alt+Q
                send(b'\x1bw')  # Probe shortcut, without submitting the draft.
                final = wait_file(state)
                self.assertEqual(final['draft'], '> ALPHA BETA\n\nFollow-up question')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=4)
                os.close(master)
