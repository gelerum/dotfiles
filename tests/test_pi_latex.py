"""Native renderer regression: PI_TEST_BINARY=/opt/pi/pi python3 -m unittest discover -s tests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.environ.get('PI_TEST_BINARY'), 'set PI_TEST_BINARY for native renderer test')
class LatexRendererTests(unittest.TestCase):
    def test_multiline_formula_preserves_equalities_and_code(self):
        extension = Path(__file__).resolve().parents[1] / 'pi/.pi/agent/extensions/latex-display.ts'
        source = r'''Поэтому в каждом отсчёте:
\[
|g_{k,j}|^2
=
\left|\frac{F_k}{N}\right|^2
\underbrace{|e^{2\pi i kj/N}|^2}_{1}
=
\frac{|F_k|^2}{N^2}.
\]

```tex
\alpha = x^2
```'''
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'render.json'
            probe = root / 'render.ts'
            probe.write_text('''
import { Markdown } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { separateDisplayMath } from %s;
export default function(pi) {
 pi.on("session_start", () => {
  const theme = Object.fromEntries(["heading","link","linkUrl","code","codeBlock","codeBlockBorder","quote","quoteBorder","hr","listBullet","bold","italic","strikethrough","underline"].map(k => [k, s => s]));
  const source = %s;
  const result = {};
  for (const width of [40, 80, 120]) result[width] = new Markdown(separateDisplayMath(source),0,0,theme).render(width).join("\\n");
  writeFileSync(%s, JSON.stringify(result));
  process.exit(0);
 });
}
''' % (json.dumps(str(extension)), json.dumps(source), json.dumps(str(output))))
            env = {**os.environ, 'PI_CODING_AGENT_DIR': str(root / 'agent')}
            subprocess.run([os.environ['PI_TEST_BINARY'], '--no-extensions', '--no-skills',
                            '--no-mcp', '--no-session', '-e', str(probe), '-p', 'render'],
                           cwd=root, env=env, check=True, capture_output=True, timeout=30)
            for width, rendered in json.loads(output.read_text()).items():
                with self.subTest(width=width):
                    self.assertNotIn('\\[', rendered)
                    self.assertEqual(rendered.count('='), 3)  # two in math, one in code
                    self.assertIn(r'\alpha = x^2', rendered)
                    self.assertIn('Fₖ', rendered)
