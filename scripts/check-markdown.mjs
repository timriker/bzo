/*
 * Lints every tracked Markdown file except CHANGELOG.md with markdownlint
 * (`mdl`, the Ruby one: `apt install markdownlint`) under .mdl-style.rb.
 *
 * mdl is not an npm package and not a dependency: a machine without it warns
 * and passes.
 *
 * mdl 0.15's MD013 exempts only a table's first row, misses some fenced code,
 * and has no way to exempt headings, so line-length hits on table rows,
 * headings and fenced code are dropped here.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '*.md', ':!CHANGELOG.md'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const run = spawnSync('mdl', ['--json', '--style', '.mdl-style.rb', ...files], { encoding: 'utf8' });
if (run.error?.code === 'ENOENT') {
  console.warn('check:markdown: mdl not found (apt install markdownlint); skipped');
  process.exit(0);
}
if (run.error) throw run.error;

let results;
try {
  results = JSON.parse(run.stdout || '[]');
} catch {
  console.error(run.stdout, run.stderr);
  process.exit(1);
}

// Per file, whether each line (0-based) may run long.
const exempt = new Map();
const isExempt = (file, n) => {
  if (!exempt.has(file)) {
    let fenced = false;
    exempt.set(file, readFileSync(file, 'utf8').split('\n').map((text) => {
      if (/^\s*(```|~~~)/.test(text)) {
        fenced = !fenced;
        return true;
      }
      return fenced || /^\s*[|#]/.test(text);
    }));
  }
  return exempt.get(file)[n - 1] ?? false;
};

const problems = results.filter(({ filename, line, rule }) =>
  rule !== 'MD013' || !isExempt(filename, line));

for (const { filename, line, rule, description } of problems) {
  console.error(`${filename}:${line}: ${rule} ${description}`);
}
if (problems.length) process.exit(1);
