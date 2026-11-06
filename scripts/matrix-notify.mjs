#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// One GitHub event as one notice in a Matrix room
// (.github/workflows/matrix-notify.yml). Reads the event Actions wrote to
// GITHUB_EVENT_PATH; everything in it is somebody's text, so it goes into
// the notice escaped and is never run.
//
// Without MATRIX_TOKEN -- a fork's run, which is given no secrets -- nothing
// is sent and the run still passes.

import fs from 'node:fs';
import crypto from 'node:crypto';

const { MATRIX_TOKEN, MATRIX_HOMESERVER, MATRIX_ROOM, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH } = process.env;
if (!MATRIX_TOKEN) {
  console.log('no MATRIX_TOKEN; nothing sent');
  process.exit(0);
}

const event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf8'));
const repo = event.repository?.name || 'bzo';
const who = event.sender?.login || 'someone';
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const firstLine = (text, limit = 120) => {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const refName = (ref) => String(ref ?? '').replace(/^refs\/(heads|tags)\//, '');

// What happened, as plain text and as a link: [text, url, extra lines].
function describe() {
  const issue = event.issue;
  const pr = event.pull_request;
  switch (GITHUB_EVENT_NAME) {
    case 'push': {
      const commits = event.commits || [];
      if (commits.length === 0) return null;
      const branch = refName(event.ref);
      const lines = commits.slice(-5).map((commit) => `${commit.id.slice(0, 7)} ${firstLine(commit.message)}`);
      if (commits.length > 5) lines.unshift(`… and ${commits.length - 5} more`);
      return [`${who} pushed ${commits.length} commit${commits.length === 1 ? '' : 's'} to ${branch}`,
        event.compare, lines];
    }
    case 'create':
    case 'delete':
      return [`${who} ${GITHUB_EVENT_NAME === 'create' ? 'created' : 'deleted'} ${event.ref_type} ${event.ref}`,
        event.repository?.html_url];
    case 'issues':
      return [`${who} ${event.action} issue #${issue.number}: ${firstLine(issue.title)}`, issue.html_url];
    case 'issue_comment':
      return [`${who} commented on ${issue.pull_request ? 'pull request' : 'issue'} #${issue.number}:`
        + ` ${firstLine(issue.title)}`, event.comment.html_url, [firstLine(event.comment.body, 200)]];
    case 'pull_request_target': {
      const action = event.action === 'closed' && pr.merged ? 'merged' : event.action;
      return [`${who} ${action} pull request #${pr.number}: ${firstLine(pr.title)}`, pr.html_url];
    }
    case 'pull_request_review': {
      const verdict = { approved: 'approved', changes_requested: 'asked for changes on' }[event.review.state]
        || 'reviewed';
      return [`${who} ${verdict} pull request #${pr.number}: ${firstLine(pr.title)}`, event.review.html_url,
        event.review.body ? [firstLine(event.review.body, 200)] : []];
    }
    case 'release':
      return [`${who} released ${event.release.tag_name}: ${firstLine(event.release.name || '')}`,
        event.release.html_url];
    case 'fork':
      return [`${who} forked ${repo} as ${event.forkee.full_name}`, event.forkee.html_url];
    case 'watch':
      return [`${who} starred ${repo}`, event.repository?.html_url];
    default:
      return null;
  }
}

const described = describe();
if (!described) {
  console.log(`${GITHUB_EVENT_NAME}: nothing to say`);
  process.exit(0);
}
const [summary, url, lines = []] = described;
const body = [`[${repo}] ${summary}${url ? ` ${url}` : ''}`, ...lines.map((line) => `  ${line}`)].join('\n');
const html = [`[${escape(repo)}] ${url ? `<a href="${escape(url)}">${escape(summary)}</a>` : escape(summary)}`,
  ...lines.map((line) => escape(line))].join('<br>');

const base = MATRIX_HOMESERVER.replace(/\/+$/, '');
const headers = { Authorization: `Bearer ${MATRIX_TOKEN}`, 'Content-Type': 'application/json' };
let room = MATRIX_ROOM;
if (room.startsWith('#')) {
  const found = await fetch(`${base}/_matrix/client/v3/directory/room/${encodeURIComponent(room)}`);
  room = (await found.json()).room_id;
}
const txnId = `gh-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${crypto.randomBytes(4).toString('hex')}`;
const response = await fetch(
  `${base}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txnId}`,
  {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      msgtype: 'm.notice', body, format: 'org.matrix.custom.html', formatted_body: html, 'm.mentions': {},
    }),
  },
);
if (!response.ok) {
  console.error(`Matrix said ${response.status}: ${await response.text()}`);
  process.exit(1);
}
console.log(`sent: ${summary}`);
