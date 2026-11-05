// Tests for the commit message check, using real git in throwaway repos.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_SUBJECT,
  SCISSORS,
  TYPES,
  messageFileProblems,
  messageProblems,
  subjectProblems,
} from '../scripts/check-commits.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-commits.js');
const HOOK = join(ROOT, '.githooks', 'commit-msg');
const ZEROS = '0'.repeat(40);
const SCISSORS_LINE = `# ${SCISSORS}`;
const LONGEST = `fix: ${'y'.repeat(MAX_SUBJECT - 5)}`;

// Hooks set GIT_DIR and friends, which would point these tests at the real repo.
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
CLEAN_ENV.GIT_CONFIG_GLOBAL = devNull;
CLEAN_ENV.GIT_CONFIG_SYSTEM = devNull;

function run(command, args, cwd, env = CLEAN_ENV) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

function script(args, cwd, env) {
  return run(process.execPath, [SCRIPT, ...args], cwd, env);
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'check-commits-'));
  const git = (...args) => {
    const result = run('git', args, repo);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = (message) => {
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { repo, git, commit, check: (value) => script([`--range=${value}`], repo) };
}

function makeHookRepo() {
  const made = makeRepo();
  mkdirSync(join(made.repo, 'scripts'));
  copyFileSync(SCRIPT, join(made.repo, 'scripts', 'check-commits.js'));
  // Without a package.json saying so, node would read the copy as CommonJS.
  copyFileSync(join(ROOT, 'package.json'), join(made.repo, 'package.json'));
  mkdirSync(join(made.repo, '.githooks'));
  copyFileSync(HOOK, join(made.repo, '.githooks', 'commit-msg'));
  made.git('config', 'core.hooksPath', '.githooks');
  return made;
}

describe('subjects', () => {
  test('good subjects pass', () => {
    for (const subject of [
      'feat: add a thing',
      'fix(labels): handle an empty title',
      'feat!: drop the old config',
      'refactor(tmdb-cache)!: split the lookup',
      'docs: mention Docker and GitHub',
      'Revert "feat: add a thing"',
      'Reapply "feat: add a thing"',
      LONGEST,
    ]) {
      assert.deepEqual(subjectProblems(subject), [], subject);
    }
  });

  test('every type passes', () => {
    for (const type of TYPES) assert.deepEqual(subjectProblems(`${type}: do it`), [], type);
  });

  test('bad subjects fail', () => {
    for (const subject of [
      '',
      'Add a thing',
      'feat add a thing',
      'feat:add a thing',
      'feat : add a thing',
      'feat: ',
      'Feat: add a thing',
      'FIX: add a thing',
      'wip: add a thing',
      'feat(): add a thing',
      'feat(Scope): add a thing',
      'feat(two words): add a thing',
      'feat!(labels): add a thing',
      'feat: add a thing.',
      'feat(app.js): add a thing',
      'feat(data_guard): add a thing',
      'feat(src/app): add a thing',
      'fix(API): add a thing',
      'feat(-x): add a thing',
      `${LONGEST}y`,
      'feat: one\nfeat: two',
      'Revert "',
      'Reapply "',
      'Reapply feat: add a thing',
      'reapply "feat: add a thing"',
    ]) {
      assert.notDeepEqual(subjectProblems(subject), [], JSON.stringify(subject));
    }
  });

  test('a pull request number at the end is ignored', () => {
    for (const subject of [
      'feat: add a thing (#12)',
      'Revert "feat: add a thing (#3)" (#13)',
      'Reapply "feat: add a thing (#3)" (#13)',
      `${LONGEST} (#12)`,
    ]) {
      assert.deepEqual(subjectProblems(subject), [], subject);
    }
  });

  test('a pull request number hides no other problem', () => {
    for (const subject of [
      `${LONGEST}y (#12)`,
      'fix: a. (#12)',
      'Add a thing (#12)',
      'feat: (#12)',
      '(#12)',
      `${LONGEST} (#1) (#2)`,
      'Revert "feat: a" (#1) (#2)',
    ]) {
      assert.notDeepEqual(subjectProblems(subject), [], subject);
    }
  });

  test('the limit is reported without the pull request number', () => {
    assert.deepEqual(subjectProblems(`${LONGEST}y (#12)`), ['the subject is 73 characters, the limit is 72']);
  });

  test('the error names the scope characters', () => {
    for (const subject of ['fix(app.js): a', 'test(data_guard): a', 'Add a thing (#12)']) {
      const [problem] = subjectProblems(subject);
      assert.ok(problem.includes('a-z, 0-9 and -'), subject);
      assert.ok(problem.includes(subject), subject);
    }
  });

  test('git merge and fixup subjects fail outside the hook', () => {
    for (const subject of ["Merge branch 'main'", 'fixup! feat: add a thing']) {
      assert.notDeepEqual(subjectProblems(subject), [], subject);
    }
  });

  test('documented types match the check', () => {
    const text = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
    const documented = [...text.matchAll(/^\| `([a-z]+)` \|/gmu)].map((match) => match[1]);
    assert.deepEqual(documented.sort(), [...TYPES].sort());
  });
});

describe('messages', () => {
  test('a body needs a blank line', () => {
    assert.deepEqual(messageProblems('feat: a\n\nbody'), []);
    assert.notDeepEqual(messageProblems('feat: a\nbody'), []);
  });

  test('an empty message fails', () => {
    assert.notDeepEqual(messageProblems('  \n'), []);
  });

  test('trailers and long bodies are left alone', () => {
    assert.deepEqual(messageProblems(`fix: a\n\n${'b'.repeat(200)}\n\nRefs: #1\n`), []);
  });
});

describe('message files', () => {
  test('comments are ignored', () => {
    assert.deepEqual(messageFileProblems('# note\n\nfeat: a\n\n# Please enter\n'), []);
    assert.notDeepEqual(messageFileProblems('# note\nAdd a thing\n'), []);
  });

  test('below the scissors is ignored', () => {
    assert.deepEqual(messageFileProblems(`feat: a\n${SCISSORS_LINE}\ndiff --git a b\nNot a rule\n`), []);
  });

  test('an empty message is left for git to refuse', () => {
    assert.deepEqual(messageFileProblems('# only a comment\n\n'), []);
    assert.deepEqual(messageFileProblems(`${SCISSORS_LINE}\nAdd a thing\n`), []);
  });

  test('git written messages pass in the hook', () => {
    for (const message of ["Merge branch 'main'", 'fixup! feat: a', 'squash! feat: a', 'amend! feat: a']) {
      assert.deepEqual(messageFileProblems(`${message}\n`), [], message);
    }
  });

  test('a bad message fails', () => {
    assert.notDeepEqual(messageFileProblems('Add a thing\n'), []);
  });

  test('the comment prefix can change', () => {
    const semicolon = { comment: ';' };
    assert.deepEqual(messageFileProblems('; note\n\nfeat: a\n\n; Please enter\n', semicolon), []);
    assert.deepEqual(messageFileProblems('; only a comment\n', semicolon), []);
    assert.deepEqual(messageFileProblems(`feat: a\n; ${SCISSORS}\nNot a rule\n`, semicolon), []);
    assert.notDeepEqual(messageFileProblems('#123 broken\n\nfeat: a\n', semicolon), []);
    assert.notDeepEqual(messageFileProblems(`feat: a\n${SCISSORS_LINE}\nNot a rule\n`, semicolon), []);
  });

  test('without an editor the text is checked as written', () => {
    const noEditor = { editorUsed: false };
    for (const text of [
      '#42 Add a thing\n',
      '# Add a thing\n',
      '# note\n\nfeat: a\n',
      'feat: a\n# note\n\nbody\n',
      `feat: a\n${SCISSORS_LINE}\nNot a rule\n`,
    ]) {
      assert.notDeepEqual(messageFileProblems(text, noEditor), [], text);
    }
    assert.deepEqual(messageFileProblems('feat: a\n\n#42 is the issue\n', noEditor), []);
  });

  test('without an editor an empty message fails', () => {
    for (const text of ['', '\n', '  \n\n']) {
      assert.deepEqual(messageFileProblems(text, { editorUsed: false }), ['the message is empty'], JSON.stringify(text));
    }
  });

  test('without an editor git written messages still pass', () => {
    for (const message of ["Merge branch 'main'", 'fixup! feat: a', 'squash! feat: a', 'amend! feat: a']) {
      assert.deepEqual(messageFileProblems(`${message}\n`, { editorUsed: false }), [], message);
    }
  });

  test('whitespace at the end of a line is removed', () => {
    for (const options of [{}, { editorUsed: false }]) {
      assert.notDeepEqual(messageFileProblems('feat: a.  \n\nbody\n', options), []);
      assert.deepEqual(messageFileProblems(`${LONGEST}  \n\nbody\n`, options), []);
      assert.deepEqual(messageFileProblems('Revert "a"\t\n\nbody\n', options), []);
      assert.deepEqual(messageFileProblems('feat: a\r\n \t\r\nbody  \r\n', options), []);
    }
  });
});

describe('command', () => {
  test('subject', () => {
    assert.equal(script(['--subject=fix: a']).status, 0);
    const result = script(['--subject=Add a thing']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTRIBUTING\.md/u);
  });

  test('a subject that looks like an option is only a bad subject', () => {
    assert.equal(script(['--subject=--range=x..y']).status, 1);
  });

  test('a missing message file cannot check', () => {
    const folder = mkdtempSync(join(tmpdir(), 'check-commits-'));
    try {
      assert.equal(script([`--message-file=${join(folder, 'missing')}`]).status, 2);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('GIT_EDITOR decides how a message file is read', () => {
    const folder = mkdtempSync(join(tmpdir(), 'check-commits-'));
    try {
      const path = join(folder, 'message');
      writeFileSync(path, '#42 Add a thing\n');
      for (const [editor, expected] of [[undefined, 0], [':', 1], ['true', 0]]) {
        const env = editor === undefined ? CLEAN_ENV : { ...CLEAN_ENV, GIT_EDITOR: editor };
        assert.equal(script([`--message-file=${path}`], folder, env).status, expected, editor);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test('needs exactly one mode', () => {
    assert.equal(script([]).status, 2);
    assert.equal(script(['--subject=fix: a', '--range=a..b']).status, 2);
    assert.equal(script(['--nonsense']).status, 2);
  });
});

describe('ranges', () => {
  let git;
  let commit;
  let check;
  let repo;

  before(() => {
    ({ repo, git, commit, check } = makeRepo());
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('a root commit on its own', () => {
    const root = commit('feat: a');
    assert.equal(check(`${ZEROS}..${root}`).status, 0);
  });

  test('only commits after before are checked', () => {
    commit('Old message from before the rule');
    const start = commit('feat: a');
    const end = commit('fix: b');
    const result = check(`${start}..${end}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 1 commit\(s\)/u);
  });

  test('every commit in the range is checked', () => {
    const start = commit('feat: a');
    const bad = commit('Add a thing');
    const end = commit('fix: b');
    const result = check(`${start}..${end}`);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(bad.slice(0, 12)));
    assert.match(result.stdout, /Checked 2 commit\(s\)/u);
  });

  test('the blank line rule applies to commits', () => {
    const start = commit('feat: a');
    const end = commit('fix: b\nno blank line');
    assert.equal(check(`${start}..${end}`).status, 1);
  });

  test('merge commits are skipped but their branch commits are not', () => {
    const start = commit('feat: a');
    git('checkout', '-q', '-b', 'side');
    commit('fix: b');
    git('checkout', '-q', 'main');
    commit('fix: c');
    git('merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side');
    const result = check(`${start}..${git('rev-parse', 'HEAD')}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 2 commit\(s\)/u);
  });

  test('squash merge subjects pass in a range', () => {
    const start = commit('feat: a');
    commit('feat: b (#12)');
    commit(`${LONGEST} (#13)`);
    const end = commit('Revert "feat: b (#12)" (#14)');
    const result = check(`${start}..${end}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 3 commit\(s\)/u);
  });

  test('a too long squash merge subject fails in a range', () => {
    const start = commit('feat: a');
    const end = commit(`${LONGEST}y (#12)`);
    assert.equal(check(`${start}..${end}`).status, 1);
  });

  test('git reverting a revert passes in a range', () => {
    const start = commit('feat: a');
    writeFileSync(join(repo, 'file'), 'text\n');
    git('add', 'file');
    commit('feat: add a file');
    git('revert', '--no-edit', 'HEAD');
    git('revert', '--no-edit', 'HEAD');
    const result = check(`${start}..HEAD`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Checked 3 commit\(s\)/u);
  });

  test('fixup commits fail in a range', () => {
    const start = commit('feat: a');
    const end = commit('fixup! feat: a');
    assert.equal(check(`${start}..${end}`).status, 1);
  });

  test('a first push checks only the newest commit', () => {
    commit('Old message from before the rule');
    const good = commit('feat: a');
    assert.equal(check(`${ZEROS}..${good}`).status, 0);
    const bad = commit('Add a thing');
    assert.equal(check(`${ZEROS}..${bad}`).status, 1);
  });

  test('before missing after a force push checks only the newest commit', () => {
    commit('Old message from before the rule');
    const good = commit('feat: a');
    assert.equal(check(`${'a'.repeat(40)}..${good}`).status, 0);
  });

  test('an unknown before is named on stderr', () => {
    commit('feat: a');
    commit('Add a thing');
    const good = commit('fix: b');
    for (const start of ['orgin/main', ZEROS, 'a'.repeat(40)]) {
      const result = check(`${start}..${good}`);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Checked 1 commit\(s\)/u);
      assert.ok(result.stderr.includes(`'${start}'`), result.stderr);
      assert.match(result.stderr, /only the newest commit was checked/u);
    }
  });

  test('an unknown before keeps the failure of the newest commit', () => {
    commit('feat: a');
    const bad = commit('Add a thing');
    const result = check(`orgin/main..${bad}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only the newest commit was checked/u);
    assert.match(result.stderr, /Commit rule/u);
  });

  test('a known before adds nothing on stderr', () => {
    const start = commit('feat: a');
    const end = commit('fix: b');
    assert.equal(check(`${start}..${end}`).stderr, '');
  });

  test('nothing new passes', () => {
    const head = commit('feat: a');
    const result = check(`${head}..${head}`);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Checked 0 commit\(s\)/u);
  });

  test('an unknown after cannot check', () => {
    const start = commit('feat: a');
    assert.equal(check(`${start}..${'a'.repeat(40)}`).status, 2);
  });

  test('a badly formed range cannot check', () => {
    const head = commit('feat: a');
    for (const value of [head, `${head}..`, `${head}...${head}`]) {
      assert.equal(check(value).status, 2, value);
    }
  });
});

test('outside a repo a range cannot check', () => {
  const folder = mkdtempSync(join(tmpdir(), 'check-commits-'));
  try {
    assert.equal(script([`--range=${ZEROS}..HEAD`], folder).status, 2);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('comment prefix', () => {
  let repo;
  let git;

  const checkFile = (text) => {
    const path = join(repo, '.git', 'typed-message');
    writeFileSync(path, text);
    return script([`--message-file=${path}`], repo).status;
  };

  beforeEach(() => {
    ({ repo, git } = makeRepo());
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('the default is a hash', () => {
    assert.equal(checkFile('# note\n\nfeat: a\n'), 0);
    assert.equal(checkFile('; note\n\nfeat: a\n'), 1);
  });

  test('comment char', () => {
    git('config', 'core.commentChar', ';');
    assert.equal(checkFile('; note\n\nfeat: a\n'), 0);
    assert.equal(checkFile('# note\n\nfeat: a\n'), 1);
  });

  test('comment string is read first', () => {
    git('config', 'core.commentChar', ';');
    git('config', 'core.commentString', '//');
    assert.equal(checkFile('// note\n\nfeat: a\n'), 0);
    assert.equal(checkFile('; note\n\nfeat: a\n'), 1);
  });

  test('auto counts as a hash', () => {
    git('config', 'core.commentChar', 'auto');
    assert.equal(checkFile('# note\n\nfeat: a\n'), 0);
    assert.equal(checkFile('automatic note\n\nfeat: a\n'), 1);
  });
});

describe('hook, one fresh repo per test', () => {
  let repo;
  let git;
  let commit;

  const tryCommit = (message) => run('git', ['commit', '--allow-empty', '-m', message], repo);
  const runGit = (...args) => run('git', args, repo);
  const subject = () => git('log', '-1', '--format=%s');

  // Commit through a real editor session that types this above git's own text.
  const editCommit = (typed, ...flags) => {
    const path = join(repo, '.git', 'typed-message');
    writeFileSync(path, typed);
    const editor = `sh -c 'cat "$0" "$1" > "$1.new" && mv "$1.new" "$1"' '${path}'`;
    return run('git', ['commit', '--allow-empty', ...flags], repo, { ...CLEAN_ENV, GIT_EDITOR: editor });
  };

  const assertRefused = (result, label) => {
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /Commit rule/u, label);
  };
  const assertNoCommit = () => {
    assert.notEqual(runGit('rev-parse', '--verify', 'HEAD').status, 0);
  };

  beforeEach(() => {
    ({ repo, git, commit } = makeHookRepo());
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('with -m comment lines are checked', () => {
    for (const message of [
      '#42 Add a thing',
      '# Add a thing',
      '# note\n\nfeat: a',
      'feat: a\n# note\n\nbody',
      `feat: a\n${SCISSORS_LINE}\nNot a rule`,
    ]) {
      assertRefused(tryCommit(message), message);
    }
    assertNoCommit();
  });

  test('with -m a hash in the body is kept', () => {
    const result = tryCommit('feat: a\n\n#42 is the issue');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(git('log', '-1', '--format=%B').includes('#42 is the issue'));
  });

  test('with a file comment lines are checked', () => {
    const path = join(repo, '.git', 'typed-message');
    writeFileSync(path, '#42 Add a thing\n');
    assertRefused(runGit('commit', '--allow-empty', '-F', path));
    assertNoCommit();
  });

  test('with no editor an empty message is refused', () => {
    const result = runGit('commit', '--allow-empty', '--allow-empty-message', '-m', '');
    assertRefused(result);
    assert.match(result.stderr, /the message is empty/u);
    assertNoCommit();
  });

  test('amend with no edit and reuse check the text as written', () => {
    git('commit', '-q', '--allow-empty', '--no-verify', '-m', '#42 Add a thing');
    assertRefused(runGit('commit', '--allow-empty', '--amend', '--no-edit'));
    assertRefused(runGit('commit', '--allow-empty', '-C', 'HEAD'));
    git('commit', '-q', '--allow-empty', '--no-verify', '--amend', '-m', 'feat: a');
    const result = runGit('commit', '--allow-empty', '--amend', '--no-edit');
    assert.equal(result.status, 0, result.stderr);
  });

  test('with -m in progress subjects still get through', () => {
    for (const message of ['feat: a', 'Merge sort added', 'squash! feat: a', 'amend! feat: a']) {
      const result = tryCommit(message);
      assert.equal(result.status, 0, result.stderr);
    }
    const result = runGit('commit', '--allow-empty', '--fixup=HEAD');
    assert.equal(result.status, 0, result.stderr);
  });

  test('in an editor comments are removed', () => {
    const result = editCommit('# note\n\nfeat: a\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(subject(), 'feat: a');
  });

  test('in an editor a bad message is refused', () => {
    assertRefused(editCommit('Add a thing\n'));
    assertNoCommit();
  });

  test('in an editor git refuses an empty message itself', () => {
    for (const typed of ['', '#42 Add a thing\n']) {
      const result = editCommit(typed);
      assert.notEqual(result.status, 0, typed);
      assert.doesNotMatch(result.stderr, /Commit rule/u, typed);
    }
    assertNoCommit();
  });

  test('in an editor whitespace at the end of a line is removed', () => {
    assertRefused(editCommit('feat: a.  \n\nbody\n'));
    let result = editCommit(`${LONGEST}  \n\nbody\n`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(subject(), LONGEST);
    result = editCommit('Revert "a"  \n\nbody\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(subject(), 'Revert "a"');
  });

  test('comment char from git config', () => {
    git('config', 'core.commentChar', ';');
    assertRefused(editCommit('#123 broken\n\nfeat: a\n'));
    let result = editCommit('; note\n');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Commit rule/u);
    assertNoCommit();
    result = editCommit('; note\n\nfeat: a\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(subject(), 'feat: a');
  });

  test('comment char with verbose', () => {
    git('config', 'core.commentChar', ';');
    writeFileSync(join(repo, 'file'), 'Not a rule\n');
    git('add', 'file');
    let result = editCommit('', '-v');
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Commit rule/u);
    result = editCommit('feat: a\n', '-v');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git('log', '-1', '--format=%B'), 'feat: a');
  });
});

describe('hook', () => {
  let repo;
  let git;

  const tryCommit = (message) => run('git', ['commit', '--allow-empty', '-m', message], repo);

  before(() => {
    ({ repo, git } = makeHookRepo());
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('the hook file is executable', () => {
    accessSync(HOOK, constants.X_OK);
  });

  test('missing node warns and lets the commit through', () => {
    const empty = mkdtempSync(join(tmpdir(), 'check-commits-'));
    try {
      const result = spawnSync('/bin/sh', [HOOK, 'unused'], { cwd: repo, env: { PATH: empty }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /skipping/u);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a bad message is refused', () => {
    const result = tryCommit('Add a thing');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Commit rule/u);
    assert.notEqual(run('git', ['rev-parse', '--verify', 'HEAD'], repo).status, 0);
  });

  test('a good message commits', () => {
    const result = tryCommit('feat: a');
    assert.equal(result.status, 0, result.stderr);
  });

  test('a merge commit gets through', () => {
    tryCommit('feat: a');
    git('checkout', '-q', '-b', 'side');
    tryCommit('fix: b');
    git('checkout', '-q', 'main');
    tryCommit('fix: c');
    const result = run('git', ['merge', '--no-ff', '--no-edit', 'side'], repo);
    assert.equal(result.status, 0, result.stderr);
  });
});
