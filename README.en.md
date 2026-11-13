# Parism

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

An MCP server and Node.js library that lets AI agents run shell commands without a shell and get the result as JSON.

Docs: [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

```json
run({ "command": "ls -la src | grep engine" })
```

```json
{
  "ok": true,
  "cmd": "ls",
  "args": ["-la", "src"],
  "stdout": {
    "raw": "",
    "parsed": {
      "entries": [{ "name": "engine", "type": "directory", "size_bytes": 4096, "permissions": "drwxrwxr-x", "owner": "user", "modified_at": "Nov 12 07:27" }],
      "_summary": { "total": 15, "matched": 1, "shown": 1 }
    }
  }
}
```

- 61 commands have parsers, and you can add your own.
- `grep`, `head`, `tail`, `wc`, `sort`, `uniq` and `cut` after a pipe run inside Parism, on the parsed rows.
- When parsing succeeds, `raw` is left out. The same 202-entry `ls -la` goes from 5,448 tokens of raw text to 2,061.
- Secret redaction, a command allowlist and path limits apply before and after each run.

## Install

```bash
npx @nerdvana/parism          # stdio MCP server
```

MCP client settings:

```json
{ "mcpServers": { "parism": { "command": "npx", "args": ["-y", "@nerdvana/parism"] } } }
```

Where each client keeps them: [Claude Code](docs/mcp-clients/claude-code.md) · [Claude Desktop](docs/mcp-clients/claude-desktop.md) · [Cursor](docs/mcp-clients/cursor.md) · [Gemini CLI](docs/mcp-clients/gemini-cli.md) · [Codex CLI](docs/mcp-clients/codex.md) · [Copilot CLI](docs/mcp-clients/copilot-cli.md)

Install these too if you need them.

```bash
npx @nerdvana/parism skill install    # agent skill: how to use Parism in few calls (.claude/skills/parism)
npx @nerdvana/parism hook install     # route the agent's Bash calls through Parism and block unverified finishes
```

Requires Node.js 20 or later.

## Tools

| Tool | Use |
|-|-|
| `run` | Run a command. Pick and sort rows, start and read tasks and services, read raw output by page |
| `query_result` | Without re-running: filter a kept result again, explain where a value came from (`pointer`), read the next page (`cursor`), compare two results (`compare_with`) |
| `describe` | Allowed commands, parsers, guard. With `command`, the guard verdict without running |

`mcp.surface: "full"` gives the nine 2.x tools.

### run

| Argument | Meaning |
|-|-|
| `command` | One command line. Or `cmd` with `args` |
| `cwd` | Working directory |
| `select`, `where`, `sort_by`, `limit` | Pick rows |
| `mode` | `"task"` for long commands, `"service"` for servers |
| `task_id`, `wait_ms`, `cancel` | Read or stop a task or service |
| `options` | `format`, `include_raw`, `contract_version`, `machine_format`, `aggregate`, `budget`, `retain`, `evidence`, `page`, `page_size`, `ready_port`, `ready_pattern`, `lease_ms`, `persist` and more. See `run_options` in `describe()` |

### One command line

Quotes, backslashes, `~`, globs, `#` comments, a leading `cd <dir> &&`, `2>&1` and `2>/dev/null` work as in a shell. `git -C <dir>` runs in that directory.

`$(...)`, `$VAR`, redirection, `&`, `;`, `&&` and `||` are not run. The result is `unsupported_shell_operator` with an alternative in `failure.suggestion`. Send one command per call.

Assignments before a command (`CI=1 npm test`, `env CFLAGS=-O0 make`) accept only variables that change that command's own behaviour: build flags, colour, logging (`CFLAGS`, `LDFLAGS`, `CI`, `NODE_ENV`, `DEBIAN_FRONTEND`, `NO_COLOR`, `RUST_LOG` and others). Variables that change which program runs or what code it loads (`PATH`, `LD_*`, `NODE_OPTIONS`, `PYTHONPATH`) are refused.

### Picking rows

```json
{ "command": "ls -l", "where": [{ "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" }, "limit": 10, "select": ["name", "size_bytes"] }
```

- Operators: `eq` `ne` `prefix` `contains` `gt` `gte` `lt` `lte`
- In `_summary`, `total` is the rows the command produced, `matched` the rows that passed the conditions, `shown` the rows returned. `limit: 0` returns only the counts.
- `aggregate: { group_by, sum, distinct }` returns one row per group with `count`, `sum_<field>`, `distinct_<field>` (`contract_version: "next"`).

### Large results

With more than 100 rows and no `limit`, the first 50 rows come back with a `result_id`. Read the rest with `query_result({ result_id, where, select, limit })`. Results are kept for 300 seconds.

A response over `mcp.max_response_bytes` (default 40,000) has `stdout.raw` cut at a line boundary, with a pointer to `options.page` for the rest.

### Tests, builds, linters

```json
{ "command": "npx vitest run", "options": { "contract_version": "next", "machine_format": true } }
```

```json
{ "kind": "test", "tool": "vitest", "passed": 41, "failed": 1,
  "failures": [{ "file": "src/math.test.ts", "line": 12, "message": "expected 2 to be 3", "attribution": "modified_line" }] }
```

- Supported: `vitest`, `jest`, `pytest`, `go test`, `cargo test|build|check`, `tsc`, `eslint`, `ruff check`, `mypy`
- Every failure and diagnostic is listed; passing tests are only counted.
- `attribution` compares each failure with `git diff HEAD`: `modified_line` (a changed line), `modified_file` (another line of a changed file) or `unmodified`.
- `| head` and `| tail` after a runner are ignored.

### Tasks and services

```json
{ "command": "cargo test", "mode": "task", "options": { "contract_version": "next" } }
{ "task_id": "task_…", "wait_ms": 30000 }
{ "command": "npm run dev", "mode": "service", "options": { "ready_port": 5173 } }
```

- A task runs up to `tasks.timeout_ms` (default 10 minutes). `wait_ms` (at most 30 s) answers as soon as the task ends or reports a new failure.
- A service is ready when `ready_port` opens or `ready_pattern` appears, and is stopped when `lease_ms` (at most 5 minutes) runs out.
- Up to `tasks.max_concurrency` (default 2) run at once. When all slots are taken, the start fails with `task_slots_full`.

## Failures

When `ok` is `false`, branch on `failure.kind`.

| `kind` | Meaning | What to do |
|-|-|-|
| `guard` | Blocked by the guard; not run | Check allowed arguments with `describe({ cmd })` |
| `config` | Shell syntax, pipe stage or filter argument error | Follow `failure.suggestion` |
| `exec` | Run failed, timed out, or the command is missing | For `spawn_failed`, use the install command in `failure.availability.install` |
| `parse` | No parser, or the parser does not read that argument format | `stdout.raw` has the output. Rerun with `hint.args` to get it parsed |

## Guard

Checked in order before running:

1. A command not in `allowed_commands`: `command_not_allowed`
2. A working directory or path argument outside `allowed_paths`: `path_not_allowed`
3. Shell metacharacters inside an argument: `injection_pattern`. Search patterns, output formats, interpreter inline code (`python3 -c`), SQL and pip version specifiers are not checked.
4. Per-command argument policies (`node -e`, `npx --yes` and others): `arg_not_allowed`

| Profile | git | Other |
|-|-|-|
| `readonly` (default) | Reads (`status`, `log`, `diff`, `show`, `branch`, `grep`, `reflog`, …) | Read commands |
| `build`, `ci` | Plus local writes (`init`, `add`, `commit`, `checkout`, `merge`, `rebase`, `reset`, `clone`, `fetch`, `pull`, …) | `npm run`·`test`, `cargo`, `npx`, `curl -o` (inside allowed paths), executables inside the workspace |

- `git push` is allowed only with `guard.allow_git_remote_write: true`.
- Every git run gets `core.hooksPath=/dev/null` and `core.editor=true`.
- The guard is a process-level defence, not a kernel sandbox. Isolation is covered in [SECURITY.md](SECURITY.md).

## Supported commands

| Group | Commands | Allowed by default |
|-|-|-|
| Files | `ls -l` `find` `stat` `du` `df` `tree` | Yes |
| Processes, network | `ps` `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | Yes |
| Text | `grep -n` `wc` `head` `tail` `cat` | Yes |
| Git | `git status` `log` `diff` `branch -vv` | Yes |
| Deploy | `kubectl get` `docker` `gh pr list` `helm list` | Yes |
| System | `env` `pwd` `which` `free` `uname` `id` `systemctl` `journalctl` `apt` `brew` `npm list` | Yes |
| Build | `terraform plan` `cargo` | build profile |
| Tests, diagnostics | `vitest` `jest` `tsc` `eslint` `pytest` `go test` `ruff` `mypy` | Add to the allowlist |
| Other | `pnpm` `yarn` `kill`, Windows `dir` `tasklist` `ipconfig` `systeminfo` | Add to the allowlist |

`describe({ cmd: "git" })` shows a command's result fields. Commands that print JSON (`kubectl -o json`, `docker inspect`) go into `parsed` as is.

## Hooks

```bash
npx @nerdvana/parism hook install                    # Claude Code, .claude/settings.json
npx @nerdvana/parism hook install --scope user       # ~/.claude/settings.json
npx @nerdvana/parism hook install --client gemini    # .gemini/settings.json
npx @nerdvana/parism hook install --client agy       # Antigravity CLI, .agents/hooks.json
```

| Hook | What it does |
|-|-|
| `PreToolUse` | Rewrites Bash commands that have a parser to `parism exec`. Blocks disallowed arguments of allowed commands (`git push`). Only read-only commands run without asking; the rest follow the client's permission rules |
| `SessionStart` | Records the workspace state at the start |
| `Stop` | Blocks the finish when the workspace changed and no test or build has passed for the current state |

The hook config is `~/.parism/hook.config.json` (build profile, receipts and redaction on). Commands the lexer does not accept run in the original shell.

## Receipts

With `"receipts": { "enabled": true }` in the host config, every run appends the command, exit code, test totals and workspace state to `~/.parism/receipts/receipts.jsonl`. Each line carries the hash of the line before it and an HMAC signature.

```bash
parism receipts check --require "npx vitest run"   # passed for the current workspace? Exit code 1 if not
parism receipts verify                             # find edited, removed or inserted lines
parism receipts export --format github             # markdown, github, sarif, json
```

The verdict is one of `ok`, `missing`, `failed`, `stale` (changed after the run), `unverifiable`, `bad_signature`. The signing key is `receipts.key_file`, or `~/.parism/receipts/receipts.key` created on first use. A process running as the same user can read that key, so put the key where the agent cannot read it if receipts must be trusted.

## Configuration

| Location | Scope |
|-|-|
| `~/.parism/prism.config.json` | Host. Every key |
| `<cwd>/prism.config.json` | Project. Cannot widen the guard; `results`, `receipts`, `verify`, `stats`, `hook` are ignored |
| `PARISM_*` environment variables | `PARISM_ALLOWED_COMMANDS`, `PARISM_ALLOWED_PATHS`, `PARISM_TIMEOUT_MS` and others |

| Key | Default | Meaning |
|-|-|-|
| `guard.allowed_commands` | Read commands | Commands that may run |
| `guard.allowed_paths` | The directory the server starts in | Scope of the working directory and path arguments. `[]` means no limit |
| `guard.profile` | `readonly` | `build`, `ci` add build and test commands and local git writes |
| `guard.timeout_ms` | 10000 | Time limit of one `run` |
| `guard.secrets.output_redaction_enabled` | `false` | Replace secrets in output, parsed results and kept results with `[REDACTED]` |
| `output.include_raw` | `false` | Keep `raw` even when parsing succeeded |
| `output.auto_retain_rows`, `output.preview_rows` | 100, 50 | Large-result preview |
| `mcp.surface` | `core` | `full` gives the 2.x tools |
| `mcp.max_response_bytes` | 40000 | Upper bound of one response |
| `tasks.max_concurrency`, `tasks.timeout_ms` | 2, 600000 | Tasks |
| `receipts.enabled` | `false` | Run receipts |
| `stats.enabled` | `true` | Usage stats for `parism stats` |

All fields are in chapter 6 of [SPECIFICATION.md](SPECIFICATION.md). `parism doctor` checks the configuration and installation.

## Library

```typescript
import { createEngine } from "@nerdvana/parism/engine";
const engine = await createEngine();
const result = await engine.run("", { command: "git status" });

import { sh } from "@nerdvana/parism/sdk";
const status = await sh.git.status();                 // typed result
const tests  = await sh.vitest.run();                 // attribution on every failure
```

Guard refusals and run failures are `ok: false` results, not exceptions.

## Custom parsers

```bash
parism capture "htop -b -n 1"    # save real output as a fixture
parism init-parser htop           # create a parser pack
parism test ~/.parism/fixtures    # check the parser against fixtures
parism add ./htop                 # register it
```

Registered packs run in a worker thread each (fault isolation). The interface and fixture format are in chapter 5 of [SPECIFICATION.md](SPECIFICATION.md).

## CLI

| Command | What it does |
|-|-|
| `parism` | MCP server |
| `parism exec -- "<command>"` | Run one command line through Parism and print like a shell |
| `parism hook install` | Install hooks |
| `parism skill install [--scope user]` | Install the agent skill |
| `parism receipts check\|list\|verify\|export` | Receipts |
| `parism stats`, `parism doctor` | Usage stats, configuration check |
| `parism capture`, `init-parser`, `test`, `add`, `inspect`, `eval` | Custom parsers |

## From 2.x to 3.0

| Item | 2.x | 3.0 |
|-|-|-|
| MCP tools | 9 | `run`, `query_result`, `describe`. The old tools: `"mcp": { "surface": "full" }` |
| `stdout.raw` | Always | Empty when parsing succeeded. `include_raw: true` restores it |
| Large results | Everything up to 500 rows | Over 100 rows, the first 50 and a `result_id`. `"output": { "auto_retain_rows": 0 }` restores the old behaviour |
| `run` advanced options | Top-level arguments | Inside `options` |
| Reading a task | `task({ task_id })` | `run({ task_id, wait_ms })` |
| Redaction scope | `raw`, `stderr` | Parsed and kept results too |
| Receipts | Signed only with `key_file` | Hash chain and signing with an automatic key |

Other changes are in [CHANGELOG.md](CHANGELOG.md).

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
