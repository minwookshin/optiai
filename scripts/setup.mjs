#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('npm', ['ci', '--ignore-scripts', '--prefix', root], { stdio: 'inherit', shell: false });
if (result.error) {
  process.stderr.write(`OptiAI setup failed: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
