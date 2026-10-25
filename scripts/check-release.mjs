#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const packageJsonPath = resolve(rootDir, 'package.json');
const packageLockPath = resolve(rootDir, 'package-lock.json');
const changelogPath = resolve(rootDir, 'CHANGELOG.md');
const clientVersionPath = resolve(rootDir, 'public', 'js', 'version.mjs');

function fail(message) {
  console.error(`Release check failed: ${message}`);
  process.exit(1);
}

function normalizeVersion(input) {
  if (!input || typeof input !== 'string') return '';
  return input.trim().replace(/^refs\/tags\//, '').replace(/^v/, '');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function getChangelogSection(content, version) {
  const lines = content.split('\n');
  const headingPrefix = `## [${version}]`;
  const startIndex = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (startIndex < 0) {
    return '';
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## [')) {
      endIndex = index;
      break;
    }
  }

  return lines.slice(startIndex + 1, endIndex).join('\n').trim();
}

const tagInput = process.argv[2] || process.env.GITHUB_REF_NAME || process.env.npm_config_tag;
if (!tagInput) {
  fail('missing tag/version argument');
}

const tagVersion = normalizeVersion(tagInput);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tagVersion)) {
  fail(`tag "${tagInput}" must be a stable SemVer release version in the form X.Y.Z (prerelease and build metadata are not published)`);
}

const packageJson = readJson(packageJsonPath);
if (packageJson.version !== tagVersion) {
  fail(`package.json version ${packageJson.version} does not match tag ${tagVersion}`);
}

const packageLock = readJson(packageLockPath);
if (packageLock.version !== tagVersion || packageLock.packages?.['']?.version !== tagVersion) {
  fail('package-lock.json version does not match package.json');
}

const clientVersionSource = readFileSync(clientVersionPath, 'utf8');
const clientVersionMatch = clientVersionSource.match(/^export const CLIENT_VERSION = '([^']*)';$/m);
if (!clientVersionMatch) {
  fail('public/js/version.mjs is missing an export const CLIENT_VERSION line');
}
if (clientVersionMatch[1] !== tagVersion) {
  fail(`public/js/version.mjs CLIENT_VERSION ${clientVersionMatch[1]} does not match tag ${tagVersion}`);
}

const changelog = readFileSync(changelogPath, 'utf8');
const section = getChangelogSection(changelog, tagVersion);
if (!section) {
  fail(`CHANGELOG.md does not contain a section for ${tagVersion}`);
}

const placeholderPatterns = [
  /Describe user-visible changes here\./,
  /Describe updated behavior here\./,
  /Describe bug fixes here\./,
  /TBD/i,
];
for (const pattern of placeholderPatterns) {
  if (pattern.test(section)) {
    fail(`CHANGELOG.md section for ${tagVersion} still contains placeholder text`);
  }
}

if (!/[A-Za-z0-9]/.test(section)) {
  fail(`CHANGELOG.md section for ${tagVersion} is empty`);
}

console.log(`Release check passed for ${tagVersion}`);
