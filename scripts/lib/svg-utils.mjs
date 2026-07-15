import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export class OptiAIError extends Error {
  constructor(message, code = 'invalid-input', exitCode = 1) {
    super(message);
    this.name = 'OptiAIError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const result = { _: [] };
  const booleanFlags = new Set(['help', 'rtl', 'in-place', 'yes', 'no-backup', 'approve', 'confirm-reviewed']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const equals = token.indexOf('=');
    if (equals !== -1) {
      const key = token.slice(2, equals);
      const value = token.slice(equals + 1);
      if (booleanFlags.has(key)) {
        if (!['true', 'false'].includes(value)) fail(`--${key} must be true or false.`, 'invalid-boolean');
        result[key] = value === 'true';
      } else result[key] = value;
      continue;
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) { result[key] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { result[key] = next; i += 1; }
    else result[key] = true;
  }
  return result;
}

export function fail(message, code = 'invalid-input', exitCode = 1) {
  throw new OptiAIError(message, code, exitCode);
}

export function handleCliError(error) {
  const known = error instanceof OptiAIError;
  process.stderr.write(`OptiAI: ${known ? error.message : `Internal error: ${error.message}`}\n`);
  process.exitCode = known ? error.exitCode : 1;
}

export function parseCsv(value, fallback = []) {
  if (value === undefined || value === true || value === '') return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export function parseSizes(value, fallback = [16, 20, 24, 32, 48]) {
  const raw = parseCsv(value, fallback);
  const sizes = raw.map(Number);
  if (!sizes.length || sizes.length > 32 || sizes.some((number) => !Number.isInteger(number) || number < 1 || number > 512)) {
    fail('Sizes must be 1–512 pixel integers with at most 32 entries.', 'invalid-sizes');
  }
  return [...new Set(sizes)];
}

export function assertKnownArgs(args, allowed) {
  const accepted = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => key !== '_' && !accepted.has(key));
  if (unknown.length) fail(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(', ')}.`, 'unknown-option');
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')); }
  catch (error) { fail(`Could not read JSON from ${path}: ${error.message}`, 'invalid-json'); }
}

export function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function offsetViewBox(viewBox, dxPercent, dyPercent) {
  return {
    x: viewBox.x - (dxPercent / 100) * viewBox.width,
    y: viewBox.y - (dyPercent / 100) * viewBox.height,
    width: viewBox.width,
    height: viewBox.height,
    raw: [viewBox.x - (dxPercent / 100) * viewBox.width, viewBox.y - (dyPercent / 100) * viewBox.height, viewBox.width, viewBox.height]
      .map((value) => formatNumber(value, 6)).join(' '),
  };
}

export function parseCorrection(args, recommendation) {
  const parse = (key, fallback) => {
    if (args[key] === undefined) return fallback;
    const value = Number(args[key]);
    if (!Number.isFinite(value)) fail(`--${key} must be a finite number.`, 'invalid-correction');
    return value;
  };
  return {
    dxPercent: parse('dx-percent', recommendation?.dxPercent ?? 0),
    dyPercent: parse('dy-percent', recommendation?.dyPercent ?? 0),
  };
}

export function writeOutput(path, content) {
  if (!path) { process.stdout.write(content.endsWith('\n') ? content : `${content}\n`); return null; }
  return atomicWrite(resolve(path), content);
}

export function atomicWrite(destination, content) {
  const temporary = resolve(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    process.stdout.write(`${destination}\n`);
    return destination;
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    fail(`Could not write ${destination}: ${error.message}`, 'write-failed');
  }
}

export function sameFile(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  if (a === b) return true;
  try {
    const aStat = statSync(a);
    const bStat = statSync(b);
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino;
  } catch { return false; }
}

export function guardOutput(input, output) {
  if (output && output !== true && sameFile(input, String(output))) fail('Refusing to overwrite the SVG input with a report artifact.', 'same-file-output-forbidden', 2);
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createExclusiveBackup(source, bytes, mode) {
  const temporary = resolve(dirname(source), `.${basename(source)}.backup.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (let index = 0; index < 10000; index += 1) {
      const destination = index === 0 ? `${source}.bak` : `${source}.bak.${index}`;
      try {
        linkSync(temporary, destination);
        unlinkSync(temporary);
        return destination;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    fail('Could not allocate a unique backup name.', 'backup-name-exhausted', 2);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    if (error instanceof OptiAIError) throw error;
    fail(`Could not create an exclusive backup: ${error.message}`, 'backup-failed', 2);
  }
}

export function atomicReplaceWithBackup(source, content, expectedSha256, useBackup = true) {
  const temporary = resolve(dirname(source), `.${basename(source)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    const sourceStat = statSync(source);
    const mode = sourceStat.mode & 0o777;
    const snapshot = readFileSync(source);
    if (createHash('sha256').update(snapshot).digest('hex') !== expectedSha256) fail('Source changed before replacement.', 'source-changed-during-apply', 2);
    fd = openSync(temporary, 'wx', mode);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (useBackup) createExclusiveBackup(source, snapshot, mode);
    if (fileSha256(source) !== expectedSha256) fail('Source changed while the backup was created.', 'source-changed-during-apply', 2);
    renameSync(temporary, source);
    process.stdout.write(`${source}\n`);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    if (error instanceof OptiAIError) throw error;
    fail(`Could not replace ${source}: ${error.message}`, 'atomic-replace-failed');
  }
}

export function canonicalPath(path) {
  try { return realpathSync(resolve(path)); }
  catch (error) { fail(`Could not resolve ${path}: ${error.message}`, 'source-unreadable'); }
}
