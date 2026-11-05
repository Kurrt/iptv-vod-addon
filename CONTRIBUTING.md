# Contributing

Issues and pull requests are welcome. The add-on has no dependencies, so please keep it
that way. For anything security related, please use [SECURITY.md](SECURITY.md) instead of
an issue.

## Tests

See [Development](README.md#development) in the README. In short, with Node 24:

```bash
node --test
```

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
type(scope): summary
```

The type is lowercase. The scope is optional and can only use a-z, 0-9 and -, starting with
a letter or digit. That's stricter than Conventional Commits, so `fix(app.js)` is refused.
Keep the line to 72 characters with no full stop at the end. To explain more, leave a blank
line and add a body.

| Type | Use it for |
| --- | --- |
| `feat` | Something new people can use |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Tests only |
| `refactor` | A code change that keeps the behaviour the same |
| `perf` | Making it faster or lighter |
| `style` | Formatting only |
| `build` | Packaging, the Dockerfile or dependencies |
| `ci` | The GitHub workflows |
| `chore` | Other upkeep that doesn't change the add-on |
| `revert` | Undoing an earlier commit |

For example:

```
feat(labels): show the source quality
fix(tmdb): keep the cache when a lookup fails
docs: explain status.json
```

If a change makes people edit their config or changes what the add-on does in a way they'd
notice, add `!` after the type or scope and say what to do in the body:

```
feat(config)!: rename the source settings

Rename the settings in your .env before you upgrade.
```

A pull request's title follows the same rule. A squash merge makes one commit, and by default
GitHub takes its subject from the title if the pull request has two or more commits, or from
the commit's own subject if it has one, then adds the pull request's number as ` (#N)`. One
` (#N)` at the end of a subject isn't counted towards the 72 characters.

`Revert "..."` messages from git and GitHub, and `Reapply "..."` messages from git, are
accepted as they are.

## The commit check

GitHub Actions checks every new commit and the pull request title. A first push or a force
push checks only the newest commit.

To catch most problems as you commit, turn on the hook:

```bash
git config core.hooksPath .githooks
```

It also lets through `Merge`, `fixup!`, `squash!` and `amend!` subjects while you work, and
Actions refuses those unless they are real merge commits.

To check your branch by hand:

```bash
node scripts/check-commits.js --range=origin/main..HEAD
```

This needs `origin/main` to exist. If it doesn't, the check says so and looks at only the
newest commit.
