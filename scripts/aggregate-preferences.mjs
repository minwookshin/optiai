#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { derivedDigest } from './lib/audit-model.mjs';
import { aggregatePreferenceCorpus, auditSourceFeatures, validatePreferenceDatum } from './lib/preference-model.mjs';
import { assertKnownArgs, fail, guardOutput, handleCliError, parseArgs, readJson, writeOutput } from './lib/svg-utils.mjs';

const HELP = `Usage: aggregate-preferences.mjs corpus.json [options]

Options:
  --min-raters N  Minimum decisive A/B raters per pair (default: 3)
  --folds N        Deterministic family/group folds, 2–10 (default: 5)
  --seed ID        Reproducible fold seed (default: optiai-v04)
  --output PATH    Write the non-authorizing dataset JSON
  --help           Show this help
`;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SOURCES = 256;
const MAX_FILES = 1024;

function exactKeys(value, keys, label) {
  const expected = new Set(keys);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has unknown or missing fields.`, 'preference-corpus-schema-invalid', 2);
  }
}

function parseJsonl(path) {
  const content = readFileSync(path, 'utf8');
  const lines = content.split(/\r?\n/u).filter((line) => line.trim());
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { fail(`Invalid JSONL in ${path} at line ${index + 1}: ${error.message}`, 'preference-jsonl-invalid', 2); }
  });
}

function validateAudit(audit) {
  if (audit?.schemaVersion !== 2 || audit?.tool !== 'OptiAI' || !audit?.source?.sha256 || !audit?.source?.viewBox?.raw) fail('Corpus audit is not an OptiAI audit v2.', 'preference-corpus-audit-invalid', 2);
  const digest = derivedDigest({ measurements: audit.measurements, decision: audit.decision, recommendation: audit.recommendation });
  if (digest !== audit.derivedSha256) fail('Corpus audit derived evidence was modified.', 'preference-corpus-audit-tampered', 2);
}

try {
  const args = parseArgs(process.argv.slice(2));
  assertKnownArgs(args, ['help', 'min-raters', 'folds', 'seed', 'output']);
  if (args.help) { process.stdout.write(HELP); process.exit(0); }
  const corpusPath = args._[0];
  if (!corpusPath) fail('Provide a preference corpus manifest.');
  if (!args.output || args.output === true) fail('Provide --output dataset.json.');
  guardOutput(corpusPath, args.output);
  const manifestPath = resolve(corpusPath);
  const manifestBytes = statSync(manifestPath).size;
  if (manifestBytes > MAX_TOTAL_BYTES) fail('Preference corpus exceeds 64 MiB.', 'preference-corpus-size-invalid', 2);
  const manifest = readJson(manifestPath);
  exactKeys(manifest, ['schemaVersion', 'tool', 'nonAuthorizing', 'sources'], 'Preference corpus');
  if (manifest.schemaVersion !== 1 || manifest.tool !== 'OptiAI Preference Corpus' || manifest.nonAuthorizing !== true) fail('Unsupported or authorizing preference corpus.', 'preference-corpus-schema-invalid', 2);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > MAX_SOURCES) fail(`Preference corpus must contain 1–${MAX_SOURCES} sources.`, 'preference-corpus-size-invalid', 2);

  const base = dirname(manifestPath);
  const sourceIds = new Set();
  const sourceHashes = new Set();
  const usedFiles = new Set();
  const rows = [];
  let totalBytes = manifestBytes;
  for (const source of manifest.sources) {
    exactKeys(source, ['sourceId', 'familyId', 'groupId', 'audit', 'preferences'], 'Corpus source');
    if (![source.sourceId, source.familyId, source.groupId].every((value) => SAFE_ID.test(value))) fail('Corpus source identifiers are invalid.', 'preference-corpus-id-invalid', 2);
    if (sourceIds.has(source.sourceId)) fail('Corpus source IDs must be unique.', 'preference-corpus-source-duplicate', 2);
    sourceIds.add(source.sourceId);
    if (typeof source.audit !== 'string' || !source.audit || !Array.isArray(source.preferences) || !source.preferences.length) fail('Corpus source paths are invalid.', 'preference-corpus-path-invalid', 2);
    const auditPath = resolve(base, source.audit);
    guardOutput(auditPath, args.output);
    totalBytes += statSync(auditPath).size;
    if (totalBytes > MAX_TOTAL_BYTES) fail('Preference corpus exceeds 64 MiB.', 'preference-corpus-size-invalid', 2);
    const audit = readJson(auditPath);
    validateAudit(audit);
    if (sourceHashes.has(audit.source.sha256)) fail('The same source hash may appear only once in a corpus.', 'preference-corpus-source-duplicate', 2);
    sourceHashes.add(audit.source.sha256);
    if (source.preferences.length + usedFiles.size > MAX_FILES) fail(`Preference corpus exceeds ${MAX_FILES} JSONL files.`, 'preference-corpus-size-invalid', 2);
    for (const relative of source.preferences) {
      if (typeof relative !== 'string' || !relative) fail('Preference JSONL paths are invalid.', 'preference-corpus-path-invalid', 2);
      const preferencePath = resolve(base, relative);
      if (usedFiles.has(preferencePath)) fail('Each preference JSONL file may appear only once.', 'preference-corpus-file-duplicate', 2);
      usedFiles.add(preferencePath);
      guardOutput(preferencePath, args.output);
      totalBytes += statSync(preferencePath).size;
      if (totalBytes > MAX_TOTAL_BYTES) fail('Preference corpus exceeds 64 MiB.', 'preference-corpus-size-invalid', 2);
      for (const row of parseJsonl(preferencePath)) {
        validatePreferenceDatum(row);
        if (row.corpus) fail('Exported preference rows must not contain corpus mapping.', 'preference-corpus-row-preassigned', 2);
        const expectedFeatures = auditSourceFeatures(audit, row.axis);
        if (row.sourceSha256 !== audit.source.sha256 || row.sourceViewBox !== audit.source.viewBox.raw || row.context !== audit.context || row.rtl !== audit.rtl || JSON.stringify(row.targetSizes) !== JSON.stringify(audit.targetSizes) || JSON.stringify(row.sourceFeatures) !== JSON.stringify(expectedFeatures)) {
          fail('Preference row does not match its corpus audit.', 'preference-corpus-row-audit-mismatch', 2);
        }
        rows.push({ ...row, corpus: { sourceId: source.sourceId, familyId: source.familyId, groupId: source.groupId } });
      }
    }
  }
  const dataset = aggregatePreferenceCorpus(rows, {
    minRaters: args['min-raters'] ?? 3,
    folds: args.folds ?? 5,
    seed: args.seed ?? 'optiai-v04',
  });
  writeOutput(args.output, `${JSON.stringify(dataset, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ readiness: dataset.readiness.status, eligiblePairs: dataset.stats.eligiblePairs, eligibleFamilies: dataset.stats.eligibleFamilyCount, eligibleGroups: dataset.stats.eligibleGroupCount, familyFolds: dataset.folds.family.effectiveFolds, groupFolds: dataset.folds.group.effectiveFolds })}\n`);
} catch (error) { handleCliError(error); }
