#!/usr/bin/env node
// Check commit messages against the commit rule in CONTRIBUTING.md.
//
//   check-commits.js --message-file=PATH    a message being written (the commit-msg hook)
//   check-commits.js --subject=TEXT         one subject line, such as a pull request title
//   check-commits.js --range=BEFORE..AFTER  the commits after BEFORE, up to and including AFTER
//
// If BEFORE isn't a known commit, as on a branch's first push or after a force push, --range
// checks only the newest commit and says so on stderr. Merge commits are skipped.
//
// One " (#N)" at the end of a subject is ignored, because a squash merge on GitHub adds it.
//
// --message-file removes comment lines and everything below the scissors, as git does after an
// editor, using the comment prefix from git's config. Git sets GIT_EDITOR to ":" for its hooks
// when no editor was opened, so then the text is checked as written.
//
// Exit status: 0 passed, 1 a message breaks the rule, 2 the check couldn't run.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
export const MAX_SUBJECT = 72;
export const SCISSORS = '------------------------ >8 ------------------------';
const SUBJECT = /^(?<type>[a-z]+)(?:\([a-z0-9][a-z0-9-]*\))?!?: \S.*$/u;
const GIT_REVERT = /^(?:Revert|Reapply) ".+"$/u;
const PR_NUMBER = / \(#[0-9]+\)$/u;
// Git writes these itself, and they're fine while working on a branch. They're only
// accepted from the hook, so they can't reach the main branch through a pull request.
const IN_PROGRESS = ['Merge ', 'fixup! ', 'squash! ', 'amend! '];

class CannotCheck extends Error {}

export function subjectProblems(subject) {
  // A squash merge on GitHub adds " (#N)", and that isn't part of the rule.
  const title = subject.replace(PR_NUMBER, '');
  if (GIT_REVERT.test(title)) return [];
  const match = SUBJECT.exec(title);
  if (!match) {
    return [
      'expected "type(scope): summary" with a lowercase type and a scope of ' +
        `a-z, 0-9 and - only, got ${JSON.stringify(subject)}`,
    ];
  }
  const problems = [];
  if (!TYPES.includes(match.groups.type)) {
    problems.push(`unknown type "${match.groups.type}", use one of: ${TYPES.join(', ')}`);
  }
  const length = [...title].length;
  if (length > MAX_SUBJECT) problems.push(`the subject is ${length} characters, the limit is ${MAX_SUBJECT}`);
  if (title.endsWith('.')) problems.push("the subject shouldn't end with a full stop");
  return problems;
}

export function messageProblems(message) {
  const trimmed = message.trim();
  if (!trimmed) return ['the message is empty'];
  const lines = trimmed.split(/\r?\n/u);
  const problems = subjectProblems(lines[0]);
  if (lines.length > 1 && lines[1].trim()) {
    problems.push('leave a blank line between the subject and the body');
  }
  return problems;
}

// What git keeps of a message from the editor: no comments, nothing below the scissors.
export function withoutComments(text, comment = '#') {
  const kept = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line === `${comment} ${SCISSORS}`) break;
    if (!line.startsWith(comment)) kept.push(line);
  }
  return kept.join('\n');
}

export function messageFileProblems(text, { editorUsed = true, comment = '#' } = {}) {
  const written = editorUsed ? withoutComments(text, comment) : text;
  // Git removes whitespace from the end of each line when it stores the message.
  const lines = written.split(/\r?\n/u).map((line) => line.replace(/[ \t\r]+$/u, ''));
  const message = lines.join('\n').trim();
  if (IN_PROGRESS.some((start) => message.startsWith(start))) return [];
  // After an editor, git refuses an empty message itself and says why.
  if (editorUsed && !message) return [];
  return messageProblems(message);
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new CannotCheck(`can't run git: ${result.error.message}`);
  return result;
}

function commentPrefix() {
  for (const key of ['core.commentString', 'core.commentChar']) {
    const value = git('config', '--get', key).stdout.replace(/\n$/u, '');
    // With auto, git picks a character per message, which a hook can't see.
    if (value) return value.toLowerCase() === 'auto' ? '#' : value;
  }
  return '#';
}

function resolve(revision) {
  const result = git('rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`);
  return result.status === 0 ? result.stdout.trim() : null;
}

function commitsIn(before, after) {
  const newest = resolve(after);
  if (!newest) throw new CannotCheck(`can't find commit ${JSON.stringify(after)}`);
  const oldest = before ? resolve(before) : null;
  const selection = oldest ? [`${oldest}..${newest}`] : ['-1', newest];
  const result = git('log', '--no-merges', '--format=%H%x00%B%x00', ...selection, '--');
  if (result.status !== 0) throw new CannotCheck(`git log failed: ${result.stderr.trim()}`);
  if (!oldest) console.error(`'${before}' isn't a known commit, so only the newest commit was checked.`);
  const fields = result.stdout.split('\0');
  const commits = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    commits.push({ sha: fields[i].trim(), message: fields[i + 1].trim() });
  }
  return commits;
}

function rangeProblems(value) {
  const at = value.indexOf('..');
  const before = value.slice(0, at);
  const after = value.slice(at + 2);
  if (at < 0 || !after || after.startsWith('.')) {
    throw new CannotCheck(`expected BEFORE..AFTER, got ${JSON.stringify(value)}`);
  }
  const commits = commitsIn(before, after);
  console.log(`Checked ${commits.length} commit(s).`);
  return commits.flatMap(({ sha, message }) =>
    messageProblems(message).map((problem) => `${sha.slice(0, 12)}: ${problem}`),
  );
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'message-file': { type: 'string' },
        subject: { type: 'string' },
        range: { type: 'string' },
      },
    }));
  } catch (error) {
    console.error(`Couldn't check: ${error.message}`);
    return 2;
  }
  const modes = Object.keys(values);
  if (modes.length !== 1) {
    console.error("Couldn't check: use one of --message-file, --subject or --range");
    return 2;
  }
  let problems;
  try {
    if (values['message-file'] !== undefined) {
      const text = readFileSync(values['message-file'], 'utf8');
      problems =
        process.env.GIT_EDITOR === ':'
          ? messageFileProblems(text, { editorUsed: false })
          : messageFileProblems(text, { comment: commentPrefix() });
    } else if (values.subject !== undefined) {
      problems = subjectProblems(values.subject);
    } else {
      problems = rangeProblems(values.range);
    }
  } catch (error) {
    console.error(`Couldn't check: ${error.message}`);
    return 2;
  }
  for (const problem of problems) console.error(`Commit rule: ${problem}`);
  if (problems.length > 0) {
    console.error('See the commit rule in CONTRIBUTING.md.');
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
