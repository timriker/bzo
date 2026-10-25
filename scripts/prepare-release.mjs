#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const packageJsonPath = resolve(rootDir, 'package.json');
const packageLockPath = resolve(rootDir, 'package-lock.json');
const changelogPath = resolve(rootDir, 'CHANGELOG.md');
const clientVersionPath = resolve(rootDir, 'public', 'js', 'version.mjs');

function fail(message) {
  console.error(`Release prepare failed: ${message}`);
  process.exit(1);
}

function normalizeVersion(input) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().replace(/^v/, '');
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeClientVersion(filePath, value) {
  const source = readFileSync(filePath, 'utf8');
  const updated = source.replace(
    /^export const CLIENT_VERSION = '[^']*';$/m,
    `export const CLIENT_VERSION = '${value}';`
  );
  if (updated === source) {
    fail(`${filePath} is missing an export const CLIENT_VERSION line`);
  }
  writeFileSync(filePath, updated, 'utf8');
}

function ensureUnreleased(changelog) {
  if (/^## \[Unreleased\]/m.test(changelog)) {
    return changelog;
  }
  return `${changelog.trim()}\n\n## [Unreleased]\n\n`;
}

function getSectionRange(content, headingPrefix) {
  const lines = content.split('\n');
  const startIndex = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (startIndex < 0) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## [')) {
      endIndex = index;
      break;
    }
  }

  return { lines, startIndex, endIndex };
}

const version = normalizeVersion(process.argv[2] || process.env.npm_config_version);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  fail('usage: npm run release:prepare -- <x.y.z> (stable SemVer only)');
}

const today = new Date().toISOString().slice(0, 10);
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
packageJson.version = version;
writeJson(packageJsonPath, packageJson);

const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
packageLock.version = version;
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = version;
  packageLock.packages[''].license = packageJson.license;
}
writeJson(packageLockPath, packageLock);

writeClientVersion(clientVersionPath, version);

const defaultChangelog = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on Keep a Changelog, and versions use SemVer tags like v${version}.\n\n## [Unreleased]\n`;
let changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : defaultChangelog;
changelog = ensureUnreleased(changelog);

if (new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(changelog)) {
  writeFileSync(changelogPath, changelog, 'utf8');
  console.log(`Prepared release ${version}. Version already exists in CHANGELOG.md.`);
  process.exit(0);
}

const unreleasedRange = getSectionRange(changelog, '## [Unreleased]');
if (!unreleasedRange) {
  fail('CHANGELOG.md is missing an [Unreleased] section');
}

const unreleasedBody = unreleasedRange.lines
  .slice(unreleasedRange.startIndex + 1, unreleasedRange.endIndex)
  .join('\n')
  .trim();
const releaseBody = unreleasedBody || [
  '### Added',
  '- Describe user-visible changes here.',
  '',
  '### Changed',
  '- Describe updated behavior here.',
  '',
  '### Fixed',
  '- Describe bug fixes here.',
].join('\n');

const replacement = `## [Unreleased]\n\n## [${version}] - ${today}\n\n${releaseBody}\n`;
const before = unreleasedRange.lines.slice(0, unreleasedRange.startIndex).join('\n');
const after = unreleasedRange.lines.slice(unreleasedRange.endIndex).join('\n');
const updated = `${before}${before ? '\n' : ''}${replacement}${after ? `\n${after}` : ''}`.replace(/\n{3,}/g, '\n\n');
writeFileSync(changelogPath, updated, 'utf8');

console.log(`Prepared release ${version}. Review CHANGELOG.md before tagging.`);
