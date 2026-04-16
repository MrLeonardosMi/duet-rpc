import { execSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

execSync('tsc -p tsconfig.build.json', { stdio: 'inherit' });
execSync('tsc -p tsconfig.esm.json', { stdio: 'inherit' });

mkdirSync('dist/cjs', { recursive: true });
mkdirSync('dist/esm', { recursive: true });

writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
