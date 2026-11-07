import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// Bundled libraries' licenses require their notices in every copy, and
// main.js is the only file a user receives.
const notices = Object.keys(pkg.dependencies ?? {}).map((name) => {
  const dir = `node_modules/${name}`;
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  if (!file) throw new Error(`${name} has no license file`);
  return `${name}\n\n${fs.readFileSync(`${dir}/${file}`, 'utf8').trim()}`;
});

const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  minify: true,
  legalComments: 'none',
  banner: { js: `/*!\n${notices.join('\n\n---\n\n').replaceAll('*/', '* /')}\n*/` },
};

// The page generator, as one file that needs only node.
const cli = await build({
  ...shared,
  entryPoints: ['src/review/cli.js'],
  target: 'node18',
  write: false,
  outfile: 'build-review.cjs',
});

await build({
  ...shared,
  entryPoints: ['src/main.js'],
  outfile: 'main.js',
  target: 'chrome108',
  external: ['obsidian', 'electron'],
  loader: { '.md': 'text', '.html': 'text' },
  define: { KIT_BUILD_SCRIPT: JSON.stringify(cli.outputFiles[0].text) },
});
