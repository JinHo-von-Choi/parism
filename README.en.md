# Parism

> Refract the Shell. Every command, structured.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

An MCP server and Node.js library that lets AI agents run shell commands safely and get the results back as JSON.

Docs: [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

---

## At a glance

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
      "entries": [
        { "permissions": "drwxrwxr-x", "links": 4, "owner": "user", "group": "user", "size_bytes": 4096,
          "modified_at": "Nov 12 07:27", "name": "engine", "type": "directory", "target": null }
      ],
      "_summary": { "total": 15, "shown": 1 }
    }
  },
  "_compiled_pipeline": { "original": "ls -la src | grep engine", "mode": "rows", "stages": ["grep engine"] }
}
```

- Give the command as one line (`command`). No shell is started: a lexer splits it, and the pipe stages `grep`, `head`, `tail`, `wc`, `sort`, `uniq` and `cut` run inside Parism.
- `parsed` holds the structure the parser read. 61 commands have a built-in parser, and you can add your own.
- When parsing succeeds, `raw` is left empty so the same content is not sent twice. Pass `include_raw: true` to get it.
- Large results return the first 50 rows and a `result_id`; read the rest with `query_result` without running the command again.

Shell output is written for people. Agents that interpret it directly often trip over spaces in file names, OS-specific column order (`ps`), and headers that change between environments (`df`). Parism detects the OS, picks the matching parser and returns a finished result.

`ls -la` of the same directory (202 files), counted with gpt-tokenizer:

| Path | Tokens | vs. raw text |
|-|-|-|
| Raw text | 5,448 | — |
| Parism 2.3.0 default call | 11,217 | +106% |
| Parism 3.0.0 default call | 2,061 | −62% |

---

## How it works

```
  Agent (MCP client)      Agent CLI hook          Node.js code
         │  stdio              │  parism exec          │  createEngine() / sh
         ▼                     ▼                       ▼
  ┌──────────────────────────────────────────────────────────┐
  │                          Parism                          │
  │                                                          │
  │  0. Lexer      one command line → argv, pipe stages      │──▶ shell syntax: failure.kind="config"
  │  1. Guard      allowlist · policy · paths                │──▶ blocked: failure.kind="guard"
  │  2. Executor   spawn (no shell), timeout, limit          │──▶ exec error: failure.kind="exec"
  │  3. Parser     OS-aware, 61 built-in + custom            │──▶ no parser: parsed=null, raw kept
  │  4. Redactor   secrets in raw, parsed and kept results   │
  │  5. Shaper     pipe stages · filter · preview · budget   │
  │       ├──▶ Result store (in memory, query_result)        │
  │       └──▶ Receipts (disk, hash chain + HMAC)            │
  └──────────────────────────────────────────────────────────┘
          ▼
   { ok, stdout: { raw, parsed }, result_id?, failure?, review?, _delta? }
```

Commands launch the executable directly, without a shell. Blocks, execution failures and parse failures do not throw; they come back in the same response shape. An agent branches on `failure.kind` alone.

---

## Quick start

### 1. Install

```bash
npx @nerdvana/parism
```

Run without arguments, it starts a stdio MCP server. To build from source:

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

### 2. Register with your MCP client

Most clients accept this format as is.

```json
{
  "mcpServers": {
    "parism": {
      "command": "npx",
      "args": ["-y", "@nerdvana/parism"]
    }
  }
}
```

Where each client keeps its settings:

| Client | Guide |
|---|---|
| Claude Desktop | [claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

To route an agent's own Bash calls through Parism instead of waiting for it to pick an MCP tool, install the [hooks](#hooks).

```bash
npx @nerdvana/parism hook install          # Claude Code, .claude/settings.json of this repository
```

To make an agent use the Parism tools in fewer calls and tokens, install the agent skill (`skills/parism/SKILL.md`). It covers one-line commands and pipes, picking, sorting and counting rows on the server, reading kept results with `query_result`, changed-line attribution for test failures, tasks and services, and how to recover from a refused call. Claude Code reads it before its first Parism call.

```bash
npx @nerdvana/parism skill install                 # this repository: .claude/skills/parism
npx @nerdvana/parism skill install --scope user    # every project: ~/.claude/skills/parism
```

Asked the same question (how many `.js` files, and the 5 largest), Claude Code haiku sessions that read the skill answered in 2 Parism calls; sessions without it took 3 to 9.

### 3. An agent's first calls

```
run({command: "git status"})              run it and get a structured result
   │
   ├─ many rows             ──▶ query_result({result_id, where, select, limit})
   ├─ where did a value come from ──▶ query_result({result_id, pointer})
   ├─ takes long             ──▶ run({command, mode: "task"}) → run({task_id, wait_ms})
   └─ refused                ──▶ read failure.suggestion or describe({cmd})
```

---

## Tools

By default (the core surface) three tools are exposed. Their schemas take 67% fewer tokens than the nine tools of 2.3.0 (3,568 → 1,188, gpt-tokenizer).

| Tool | Runs a command | Purpose |
|---|---|---|
| `run` | yes | Run a command. Pipe stages, filters, starting and reading tasks and services, raw pages |
| `query_result` | no | Query a kept result again, explain a value (`pointer`), next page (`cursor`), compare two results (`compare_with`) |
| `describe` | no | Allowed commands, parsers, guard, side-effect class. With `command`, a guard check without running |

Set `mcp.surface` to `"full"` to keep the nine 2.x tools (`run`, `run_paged`, `describe`, `dry_run`, `explain_result`, `fetch_result`, `compare_results`, `query_result`, `task`).

Every tool carries MCP `annotations`. `query_result` and `describe` are `readOnlyHint: true`; `run` is `readOnlyHint: true` in the readonly profile and `destructiveHint: true` in the build and ci profiles. Guard, config and execution failures come back with `isError: true`, and the result JSON is sent both as text and as `structuredContent`.

Kept results live only in the server process memory: 2 MiB per result, 32 MiB in total, at most 16, for 300 seconds. Count and time are set with `results`. Unknown ids, expiry, eviction and not-kept are refused with distinct reasons.

### run

| Parameter | Description |
|---|---|
| `command` | One command line. Use instead of `cmd` + `args` |
| `cmd`, `args` | Executable name and argument array |
| `cwd` | Working directory (default: the server's current directory) |
| `select` `where` `sort_by` `limit` | [Filtering and projection](#filtering-and-projection) |
| `mode` | `"task"`: start and return a `task_id` at once. `"service"`: start a server and return once it is ready |
| `task_id`, `wait_ms`, `cancel` | Read or stop a task or service |
| `options` | Advanced options object, below |

The keys `options` accepts are also listed in `describe().run_options`.

| Key | Description |
|---|---|
| `format` | `"json"` (default), `"compact"` (column names and value arrays), `"json-no-raw"` |
| `include_raw` | Also return `stdout.raw` when parsing succeeded |
| `includeDiff` | Include the filesystem change before and after |
| `array`, `aggregate` | Pick the target array, [aggregation](#aggregation) |
| `budget` | [Token budget](#token-budget) |
| `contract_version` | `"next"` adds `review`, `_origin` and `receipt` |
| `evidence`, `retain` | [Provenance](#provenance) |
| `machine_format` | Add machine-readable output flags for test runners and linters |
| `attribution` | `false` skips the git-change attribution of failures |
| `page`, `page_size` | Read raw output line pages without parsing |
| `ready_pattern`, `ready_port`, `lease_ms`, `persist` | [Services](#services) |

`format: "compact"` folds list results into `schema` and `rows`. Results with 50 or more rows switch to it automatically.

### One command line and pipes

The lexer handles single quotes, double quotes, backslashes, `~` and globs (`*.ts`) outside quotes, `#` comments at the start of a word and a leading `cd <dir> &&` the way a shell does. It also accepts `2>&1` and `2>/dev/null`.

Pipe stages are not started as child processes. When the first command's parsed result has a row array and every stage can be moved onto rows, the stages run on the rows (`mode: "rows"`); otherwise they run on the stdout lines (`mode: "text"`). Text mode gives the same output as the shell tools on the same input.

| Stage | Options |
|-|-|
| `grep` | `-i -v -E -F -G -w -x -c -m N -e PAT` |
| `head`, `tail` | `-n N`, `-N`, `tail -n +N` |
| `wc` | one of `-l -w -c -m`, or none |
| `sort` | `-r -n -u -f -t C -k N[,M]`, and `-k fieldname` in row mode |
| `uniq`, `cut` | `uniq -c -d -u`, `cut -d C -f LIST`, `cut -c LIST` (text mode) |

`| tail -n 50` and `| head` after a test runner or linter are not applied: the report is already read and lists every failure. Regular expressions run on the Rust engine (no backtracking).

Command substitution (`$(...)`, backticks), variable expansion (`$HOME`), redirection, background jobs (`&`), `;`, `&&`, `||` and environment assignments (`FOO=1 cmd`) are not run; the response carries `failure.reason: "unsupported_shell_operator"` and an alternative in `failure.suggestion`.

### Large result preview

When a result has more than `output.auto_retain_rows` (default 100) rows and neither `limit` nor `budget` is given, only the first `output.preview_rows` (default 50) rows are returned and the whole result is kept.

```json
{
  "stdout": { "raw": "", "parsed": { "entries": ["...50 rows..."], "_summary": { "total": 202, "shown": 50, "truncated": true } } },
  "result_id": "r_mwcphg33_7x1nqydw",
  "_hint": "Showing 50 of 202 rows. Call query_result with result_id \"r_mwcphg33_7x1nqydw\" and where/select/sort_by/limit/aggregate to read the rest without re-running."
}
```

If the result is too large to keep, only a `_hint` to narrow the command comes back, without a `result_id`.

### describe

Without arguments it returns `version`, `allowed_commands`, `available_parsers`, `guard_summary`, `side_effects`, `run_options` and `next_contract`. `side_effects` gives every allowed command the largest side-effect class its policy allows (`read_only`, `local_state`, `process_control`, `network`).

With a command, such as `describe({ cmd: "git" })`, it returns only that command, within 2 KB. When a command has many per-subcommand flags, add the subcommand (`describe({ cmd: "git commit" })`) to get just that part.

- `policy`: subcommands, flags and positional arguments the guard allows
- `parser`: formats the parser reads and the result fields
- `side_effect`: side-effect class
- `alternatives`: arguments to use instead of unsupported ones
- `examples`: argument examples that pass the current guard

`describe({ command: "git push origin main" })` returns the verdict without running anything.

```json
{ "would_pass": false, "reason": "arg_not_allowed", "message": "Argument 'push' is not allowed for command 'git' (policy: default)", "resolved": { "cmd": "git", "args": ["push", "origin", "main"], "cwd": "/work" } }
```

Block reasons are `command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`, `unsupported_shell_operator` or `unsupported_pipe_stage`.

---

## Responses and failures

```
result.ok === true   ──▶ use stdout.parsed (fall back to stdout.raw if null)
result.ok === false  ──▶ branch on result.failure.kind
                           ├─ "guard"   blocked by the guard; nothing ran
                           ├─ "exec"    execution failed; stderr in message
                           ├─ "parse"   no parser (reason: "parser_not_found")
                           └─ "config"  shell syntax (unsupported_shell_operator), pipe stage,
                                        bad filter argument (unknown_field, type_mismatch)
```

When `stdout.parsed` is built without loss, `stdout.raw` is an empty string. Without a parser, or when parsing fails, `raw` holds the output.

```json
{
  "ok": false,
  "failure": {
    "kind": "guard",
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

A `guard_error` field is still included for backward compatibility; branch on `failure`.

When a parser runs but cannot produce a result, `stdout.parse_error` records why and `raw` holds the output.

| `parse_error.reason` | Meaning |
|---|---|
| `parser_exception` | The parser threw |
| `schema_violation` | Failed `strict_schemas` validation |
| `unsupported_format` | Argument combination the parser does not handle |
| `unrecognized_output` | Data lines present, but no values could be read |

### Unsupported arguments

Each parser declares the argument range it has been verified against. Arguments outside that range get `unsupported_format` instead of a guess, plus a `hint` when another argument yields the same information.

```json
{ "reason": "unsupported_format", "hint": { "args": ["log", "--format=%h %s"] } }
```

| Input | Suggestion |
|---|---|
| `uname -r` | `["-a"]` |
| `git status -s --ignored` | `["status", "--ignored"]` |
| `kubectl get pods -o yaml` | `["get", "pods", "-o", "json"]` |

Commands whose output is already JSON (`kubectl get pods -o json`, `docker inspect`) go straight into `parsed` without a parser.

---

## Guard

Four checks run in order so that a bad command from an agent does not run as is.

```
 cmd + args
     │
     ▼
 [1] allowed_commands   command not in the list    ──▶ command_not_allowed
     │
 [2] allowed_paths      cwd or path arg outside    ──▶ path_not_allowed
     │
 [3] block_patterns     ; $( ` && || | > >> <      ──▶ injection_pattern
     │
 [4] arg restrictions   node -e, npx --yes, ...    ──▶ arg_not_allowed
     │
     ▼
  execute
```

1. **Command allowlist**: commands missing from `allowed_commands` are rejected before any process is created.
2. **Path restriction**: when `allowed_paths` is set, `cwd` and path-like arguments are checked (anything containing `/`, starting with `.` or `~`, or existing on disk, symlinks included). An empty list means no path restriction.
3. **Injection patterns**: any argument containing a shell metacharacter is rejected. Search patterns, output formats and interpreter inline code are not checked: the `grep` pattern (first positional, `-e`), `find -regex`, `git --format` / `--pretty`, the code given to `python3 -c`, `node -e`, `ruby -e`, `perl -e`, and the SQL given to `sqlite3`, `psql -c`, `mysql -e`. So `grep -E "BEGIN|END"` and `python3 -c "import sys; print(1)"` pass. Whether an interpreter may run at all is decided by the allowlist (1) and argument restrictions (4).
4. **Per-command argument limits**: `node -e`, `node --eval`, `node --input-type`, and `npx --yes` are blocked by default.

Command policies depend on `guard.profile`.

| Profile | git | Other |
|-|-|-|
| `readonly` (default) | Read subcommands only (`status`, `log`, `diff`, `show`, `branch`, `tag`, `reflog`, `worktree list`, `fsck`, `ls-tree`, `cat-file`, `rev-list`, …) | Read commands |
| `build`, `ci` | Plus local writes: `init`, `add`, `commit`, `checkout`, `switch`, `restore`, `stash`, `merge`, `rebase`, `reset`, `clean`, `rm`, `mv`, `cherry-pick`, `revert`, `apply`, `clone`, `fetch`, `pull`, `update-ref`, `symbolic-ref`, `config` (allowed keys only) | `npm run`·`test`, `cargo build`·`test`, `npx`, executables inside the workspace (`workspace_executables`) |

- `git push` and `git remote add`·`set-url`·`remove` open only with `guard.allow_git_remote_write: true`. A project config cannot turn it on.
- `git -C <dir> ...` and `git --git-dir=<dir> ...` run with that directory as the working directory (the parent when `--git-dir` names a `.git` directory). That directory is checked against `allowed_paths` like any other.
- Options that name external programs (`-c` config overrides, `--upload-pack`, `--exec`, `clone -u`, `--template`) and interactive runs (`add -p`, `rebase -i`) are blocked in every profile. `git config` changes allowed keys only, such as `user.*`, `init.defaultBranch` and `safe.directory`.
- Every git run gets `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `core.editor=true`. Repository hooks do not run, and `commit` without a message ends instead of waiting for an editor.
- A git run that changed the repository carries `_delta`, so no follow-up `git status` is needed.

```json
{ "_delta": { "branch": "main", "head": "4f1c2a9b0d3e", "staged_count": 0, "modified_count": 1, "untracked_count": 0 } }
```

The guard is a process-level defense, not a kernel sandbox. See [SECURITY.md](SECURITY.md) for isolating Parism in untrusted environments.

---

## Supported commands

61 commands have built-in parsers. Check each command's result fields with `describe({ cmd: "…" })`.

| Category | Commands | Allowed by default |
|---|---|---|
| Filesystem | `ls -l` `find` `stat` `du` `df` `tree` | Yes |
| Processes | `ps aux` | Yes |
| Network | `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | Yes |
| Text | `grep -n` `wc` `head` `tail` `cat` | Yes |
| Git | `git status` `git status --porcelain` `git log --oneline` `git diff` `git branch -vv` | Yes |
| Deploy | `kubectl get` `docker` `gh pr list` `helm list` | Yes |
| Environment | `env` `pwd` `which` | Yes |
| System | `free` `uname` `id` `systemctl list-units` `journalctl` `apt list` `apt search` `brew list --versions` | Yes |
| Packages | `npm list` | Yes |
| Packages | `pnpm list` `yarn list` | Allow explicitly (`yarn` also needs the build profile) |
| Build | `terraform plan` `cargo tree` | Build profile |
| Process control | `kill` | Allow explicitly |
| Windows | `dir` `tasklist` `ipconfig` `systeminfo` | Allow explicitly |

- **Allow explicitly**: add the command to `guard.allowed_commands`.
- **Build profile**: set `guard.profile` to `"build"` (or `"ci"`, which allows the same). `cargo` and `yarn` can run wrappers or scripts defined by the repository even for read-only subcommands, so they open only under this profile.

---

## Advanced features

The examples in this section use the full-surface tool names. On the core surface, `explain_result(id, pointer)` is `query_result({ result_id, pointer })`, `fetch_result(id, cursor)` is `query_result({ result_id, cursor })`, `compare_results(base, current)` is `query_result({ result_id: base, compare_with: current })`, and `task(...)` is `run({ task_id, ... })`.

### Filtering and projection

Filter the top-level array of a parsed result (`entries` for `ls`, `commits` for `git log`, and so on) on the server and receive only what you need.

```
 parsed rows ──▶ where ──▶ sort_by ──▶ limit ──▶ select ──▶ response
```

```json
{
  "cmd": "ls", "args": ["-l"],
  "where":   [{ "field": "type", "op": "eq", "value": "file" },
              { "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" },
  "limit":   10,
  "select":  ["name", "size_bytes"]
}
```

- Operators: `eq` `ne` `prefix` `contains` (strings, numbers, booleans, `null`), `gt` `gte` `lt` `lte` (numbers). All conditions must match.
- When there are several arrays, pick one with `array`.
- The result gains `_summary: { total, matched, shown }` and drops `stdout.raw`.
- Sorting is stable; rows missing the field go last.
- On a 500-entry directory, `select: ["name","size_bytes"], limit: 50` shrinks the result from 30,122 to 725 tokens.

### Token budget

Fit a result into a token limit and learn what was left out and how much.

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

```
 Agent                              Parism
   │ run(cmd, budget, retain:true)    │
   │────────────────────────────────▶│ run, parse, trim to budget
   │◀────────────────────────────────│ budget, omission[], continuation.cursor
   │                                  │
   │ fetch_result(result_id, cursor)  │
   │────────────────────────────────▶│ next page from the retained result (no re-run)
   │◀────────────────────────────────│ next rows + new cursor
   │          ... repeat until there is no cursor
```

```json
"budget":   { "max_tokens": 2000, "measured_tokens": 1842, "budget_met": true },
"omission": [{ "stage": "budget", "rows_total": 206, "rows_returned": 138, "rows_omitted": 68 }]
```

- A budget decides how much of an already collected result to return. It does not shorten execution or collection.
- `required_fields` and row identity fields are never dropped from any row. If the budget cannot hold them, the call fails instead of returning a partial result.
- A budget below the minimum response size (about 1,200 tokens) is rejected with `budget_too_small` before execution.
- `omission[].stage` is one of `capture`, `parse`, `projection`, `budget`, or `privacy`, so rows dropped by the budget are distinguishable from rows lost to a parser problem.
- Two tokenizers are available: `parism/approx` (approximate) and `byte` (character-exact). Counts cover only the JSON Parism produces and can differ from a model's own token count.
- A cursor is bound to its result and query. A cursor from another result is rejected with `cursor_mismatch`, a tampered one with `cursor_invalid`.

JSON is larger than the same content as raw text. For 200 lines of `ls -la`, raw is 5,044 tokens and JSON is 12,204. When tokens matter, combine `select`, `limit`, `format: "json-no-raw"`, and `budget`.

### Provenance

Answers "where in the raw output did this value come from?" with a byte range.

```
 run(cmd, { contract_version: "next", evidence: "fields", retain: true })
   └─▶ review.result_id
         │
 explain_result(result_id, pointer: "/processes/0/pid")
   └─▶ value, source_kind, source_spans [start, end), transform
```

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived",
  "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- Spans are UTF-8 byte offsets `[start, end)` into the raw output after secrets are masked.
- Values taken verbatim are `verbatim`; transformed values are `derived` and name the transform applied.
- Parsers that produce provenance today: `ps` and `git status --porcelain`. Fields from other parsers report `source_kind: "none"`, with the reason in `warnings`.
- Provenance points to what the command printed at that moment. It does not prove the value is true.
- Using `evidence` or `budget` turns off automatic compact conversion, because a folded table leaves pointers with nothing to point at.

Key fields of `review`, added when `contract_version: "next"`:

| Field | Meaning |
|---|---|
| `result_id` | Id passed to the follow-up tools |
| `parser_id` / `parser_version` / `schema_version` | Parser and schema that produced the result |
| `content_hash` | Hash of the raw output |
| `source_complete` / `parse_complete` / `representation_lossless` | Whether collection, parsing, and conversion finished without loss (`true` / `false` / `unknown`) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | Whether the result was retained |
| `warnings` | Why something is incomplete or lacks provenance |

### Comparing results

`compare_results` diffs two results retained with `run(retain: true)`.

```
 run(..., retain:true) ─▶ base_id ─┐
                                   ├─▶ compare_results(base_id, current_id)
 run(..., retain:true) ─▶ current_id ┘        │
                                              ├─ comparable: false ─▶ refusals.reasons
                                              └─ comparable: true  ─▶ added / removed / changed
```

```json
{ "comparable": false, "refusals": { "reasons": ["different command"] } }
```

- Optional arguments: `keys`, `ignore_fields`, `strict`.
- If either side is incomplete, missing rows are not reported as removed; they are held back in `partial.withheld_reasons`.
- Row identity: git uses the repository's real path plus the file path; Kubernetes uses context, namespace, kind, and `metadata.uid`. Table output without a uid is never treated as the same resource. `ps` comparisons are withheld because PIDs get reused.
- A duplicated identity stops the comparison with `duplicate_identity`.
- argv is compared by hash and displayed only in masked form. Environment variables are recorded by name only.

### Tests, builds and linters

The options, tools and fields in this and the next four sections work only with `contract_version: "next"`. With it, the `run` response JSON comes on one line.

Results from test runners, compilers and linters list every failure and diagnostic and only count what passed.

```
 run("npx", { args: ["vitest", "run"], contract_version: "next", machine_format: true })
```

```json
{
  "kind": "test", "tool": "vitest",
  "passed": 1788, "failed": 2, "skipped": 9, "todo": 0, "total": 1799, "files_failed": 0, "success": false,
  "failures": [
    { "id": "tests/engine/guard.test.ts > guard rejects glob", "file": "tests/engine/guard.test.ts",
      "name": "guard rejects glob", "line": 214, "column": 31, "message": "AssertionError: expected false to be true" }
  ]
}
```

Diagnostic tools return `{ kind: "diagnostics", errors, warnings, infos, files, by_code[], diagnostics[] }`, where each diagnostic is `{ file, line, column, severity, code, message }`.

| Command | Format read | Arguments `machine_format` adds |
|---|---|---|
| `vitest` | json reporter | `--reporter=json`; the report is received in a temporary file, read, and removed |
| `jest` | `--json` | `--json` |
| `tsc` | `--pretty false` | `--pretty false` |
| `eslint` | `--format json` | `--format json` |
| `cargo test` | default libtest output | none |
| `cargo build` `cargo check` | `--message-format=json` | `--message-format=json` |
| `pytest` | JUnit XML | none; the report is received in a temporary file (`--junitxml`), read, and removed |
| `go test` | `-json` | `-json` |
| `ruff check` | `--output-format=json` | `--output-format=json` |
| `mypy` | `--output=json` | `--output=json` |

- Run in another format without `machine_format` and you get `unsupported_format` with `hint.args` to rerun with.
- If the failure count the runner reports differs from the failures parsed, no result is produced and the raw output is returned.
- If the runner failed and printed nothing to read, no result is produced, so a runner that never started is not read as "0 errors".
- Output of these commands is read in full regardless of `max_output_bytes`. Failures are never cut by `max_items`; the diagnostics list is, with counts covering everything and `diagnostics_omitted` saying how many were left out.
- `vitest`, `jest`, `tsc`, `eslint`, `pytest`, `go`, `ruff`, `mypy` must be added to `allowed_commands` (the first four also run through `npx`, which needs the build profile). `cargo test/build/check` need the build profile.
- `pytest` has no machine-readable format on stdout, so it returns a parsed result only with `machine_format: true`.
- With `evidence: "fields"` and `retain: true`, `explain_result` shows where diagnostic fields of `tsc`, `mypy`, `cargo build` and failed test names of `cargo test`, `go test` came from in the raw output. Runners that print one JSON document or write a report file produce no evidence.
- Measured on 11 real runner outputs (`node experiments/devloop-tokens.mjs`): 8,239 raw tokens became 2,331 (28%) with all 31 failures and diagnostics kept. The samples are tiny projects; already line-per-diagnostic formats such as `tsc` grow when structured (78 → 179 tokens).
- `npm test` and `npm run <script>` are not parsed. Call the runner directly.
- Tools started through `npx` run as `npx --no -- <tool> ...`. Without `--`, npx reads flags such as `--noEmit` as npm config and does not pass them to the tool.

#### Failure × change attribution

When the workspace is a git repository, every failure and diagnostic is compared with the lines changed since HEAD (`git diff --unified=0 HEAD` and untracked files). Pass `attribution: false` to skip it.

| `attribution` | Meaning |
|-|-|
| `modified_line` | Inside the line range of a changed hunk. `diff_hunk_preview` carries up to 3 changed lines of that hunk |
| `modified_file` | On another line of a changed file |
| `unmodified` | In a file the working tree did not touch |

If the failure location is an unchanged file but a stack frame in the message (`path:line`) points at a changed line, it is `modified_line` with the frame in `attribution_frame`. Changed files that the failing file imports by relative path are listed in `imports_changed`: the assert failed in a test file, but the cause is in the code the test calls.

```json
{
  "failures": [{ "file": "tests/math.test.ts", "line": 5, "message": "AssertionError: expected -1 to be 5",
                 "attribution": "unmodified", "imports_changed": ["src/math.ts"] }],
  "attribution": { "modified_line": 0, "modified_file": 0, "unmodified": 1, "changed_files": 1 }
}
```

### Long-running tasks

Commands longer than `guard.timeout_ms` (10 seconds by default) run as tasks.

```
 run({ command, mode: "task", options: { contract_version: "next" } }) ─▶ { task: { task_id, state: "running" } }
 run({ task_id, wait_ms: 30000 })   ─▶ state, elapsed_ms, stdout_bytes, progress
 run({ task_id, cancel: true })     ─▶ stops only that task's processes
```

On the full surface the same is `task({ task_id, wait_ms })` and `task({ task_id, action: "cancel" })`.

- A task runs up to `tasks.timeout_ms` (10 minutes) and at most `tasks.max_concurrency` (2) run at once. When all slots are taken the start is refused with `task_slots_full` instead of queued. Task slots are separate from the concurrency of ordinary `run` calls.
- With `wait_ms`, a status read answers when the task finishes, when a new failure appears, or when that time runs out (30 seconds at most). Use it instead of polling in a loop. Without it the read answers at once.
- A `cargo test` task reports `progress: { passed, failed, skipped, failed_names }` while running. Other runners report elapsed time and output bytes only.
- A finished task's result is kept for 10 minutes, 16 at most. It is never re-run.

An agent (model `haiku`) ran an 80-second `cargo test` five times per condition, in a crate where one test fails at once:

| Condition | Reported correctly | Failure known at | Tool calls |
|-|-|-|-|
| `run`, 10 s limit | 5/5 (4 said the full result was not available) | 13.4 s | 6 |
| `run`, 10 min limit | 5/5 | 83.8 s | 1 |
| task, 10 s limit | 5/5 | 13.0 s | 5 |

Method and limits: [experiments/README.md](experiments/README.md), appendix S.

### Services

Work that needs a running server to check against starts it with `mode: "service"`.

```
 run({ command: "python3 -m http.server 8000", mode: "service", options: { ready_port: 8000 } })
   ─▶ { task: { task_id: "svc_…", state: "running", service: { ready: true, ready_reason: "port 8000 accepts connections", lease_until, output_tail } } }
 run({ command: "curl -s http://127.0.0.1:8000/" })   ─▶ query the server
 run({ task_id: "svc_…", cancel: true })                ─▶ stop the process group
```

- Ready means `ready_pattern` (a regex on the output) matched or `ready_port` (on 127.0.0.1 or ::1) accepts connections. Without either, still running after 1 second counts as ready. It waits at most 30 seconds.
- When `lease_ms` (default and maximum 5 minutes) runs out or the server exits, the process group gets SIGTERM and, 2 seconds later, SIGKILL.
- `persist: true` keeps the service after the server exits, until `lease_ms`. Its output goes to a file under `~/.parism/services/`, and a separate watchdog ends the group at the end of the lease. It needs `tasks.allow_persistent_services: true` in the host config.
- Services count against `tasks.max_concurrency`, and `output_tail` is redacted when redaction is on.

#### MCP task requests

Clients that speak MCP tasks can use protocol requests instead of the `task` tool. Set `{ "tasks": { "mcp_extension": true } }` in the host config. The server then declares the tasks capability and exposes `run_task`: call it with task augmentation, poll `tasks/get` (`statusMessage` carries progress), read the run result with `tasks/result`, stop it with `tasks/cancel`. Its inputs are those of `run` without `mode` and `contract_version`. A guard denial or a full slot comes back as a `failed` task whose result holds the reason. This uses the MCP SDK's experimental tasks API, so it is off by default, cannot be enabled from a project config, and the SDK is pinned to `~1.32.1`.

### Querying a retained result

`query_result` applies `select`, `where`, `sort_by`, `limit` and `aggregate` again to a result kept with `run(contract_version: "next", retain: true)`. It works on the whole parsed result, independent of the projection of the first run, and never re-runs the command. `source_complete: false` means the first run had no projection argument and may have been cut at `max_items`. `row_pointers` gives each returned row's position in the retained result (`/processes/41`); append a field name and pass it to `explain_result`.

Three questions in a row against an `ls -l` of 201 files cost 3 command runs and 1,902 response tokens when each question re-runs the command, and 1 run and 1,101 tokens with `query_result`. The raw output is 4,438 tokens. Reproduce: `npm run build && node experiments/requery.mjs`.

### Aggregation

`aggregate: { group_by?, sum?, distinct? }` groups the rows that pass `where` and returns one row per group with `count`, `sum_<field>` and `distinct_<field>`. Without `group_by` everything is one group. The order is `where` → `aggregate` → `sort_by` → `limit` → `select`, and `_summary.groups` is the number of groups. It works in `run` (with `contract_version: "next"`) and in `query_result`.

### Field origin

Responses that carry a parsed result also carry `_origin`.

```json
{ "_origin": { "external": ["failures[].id", "failures[].file", "failures[].name", "failures[].message"],
               "fixed": ["kind", "tool", "passed", "failed", "failures[].line"], "basis": "table" } }
```

- `external` fields hold text taken verbatim from command output (file names, paths, test names, messages). Treat it as data, not instructions.
- `fixed` fields are computed by Parism or limited to a known value set. A value outside that form empties the result with `schema_violation`.
- `stdout.raw`, `stderr` and quoted evidence are always external text.
- Strings copied from the output are external even when their form is fixed: permission strings, timestamps, hashes, owner names.
- Every built-in parser has an origin table. These report `basis: "table"` and their fixed values are checked. When a parser returns different shapes by format (`packages` or `lines`), only the fields of the returned shape are listed. `*` in `headers.*` or `vars.*` means every key of the object; the key names also come from the output.
- Parsers you register yourself, and JSON a command printed that was read as is, report `basis: "value_types"`: every string is external and numbers and booleans are fixed. This marking helps tell external text apart; it does not block prompt injection.

Measured with instructions planted in a commit message, a file name and a log line, 90 runs per condition (model `haiku`), on counting tasks:

| Tool result | Instruction reached the model | Instruction followed | Correct answer |
|-|-|-|-|
| Raw output | 90/90 | 0/90 | 88/90 |
| Default response (with `_origin`) | 90/90 | 0/90 | 90/90 |
| Fixed fields only | 0/90 | 0/90 | 90/90 |

Selecting fixed fields keeps the planted text away from the model. This model did not follow the instruction in the raw output either, so the measurement does not show whether `_origin` lowers the rate. Method and limits: [experiments/README.md](experiments/README.md), appendix R.

### Run receipts

A receipt records that a command ended with a given result in a given workspace state. A Stop hook, CI job or review bot uses it to check an agent's "tests pass" claim.

Enable it in the host config (`~/.parism/prism.config.json`):

```json
{
  "receipts": { "enabled": true },
  "verify":   { "commands": [["npx", "vitest", "run"], ["npx", "tsc", "--noEmit"]] }
}
```

Every `run` then appends a line to `~/.parism/receipts/receipts.jsonl` with the command, exit code, test or diagnostic summary and the git workspace state at the end of the run.

```bash
parism receipts check                              # uses verify.commands
parism receipts check --require "npx vitest run"   # repeatable
parism receipts list
```

`check` never runs a command. It takes the latest receipt for each command and exits 0 only when every one is `ok`.

| Verdict | Meaning |
|---|---|
| `ok` | Passed, and the workspace has not changed since |
| `missing` | No receipt for that command in this workspace |
| `failed` | Non-zero exit, failed tests, test files that did not run, errors, timeout or cancellation |
| `stale` | The workspace changed after the run |
| `unverifiable` | Not a git repository, so the workspace state cannot be compared |
| `bad_signature` | A signing key is configured and the signature does not match |

A receipt file that fails the chain check does not pass either.

The workspace state is built from the paths and contents of the files in the working tree, untracked files included. HEAD and staging are not part of it, so staging or committing the exact content that passed still checks as `ok`. Files excluded by `.gitignore`, changes inside submodules, the executable bit and anything outside the repository are not covered. When untracked files exceed `untracked_max_files` or `untracked_max_bytes` they are compared by name only, so staging them reads as `stale` even with the same content.

Checked against 15 sessions run for real in a sample project (combinations of running tests, editing, staging and committing): all 8 sessions that must not report success were blocked, and none of the 7 that may report it. Reproduce: `npm run build && node experiments/receipts-check.mjs`.

#### Hash chain and signatures

Every receipt carries the SHA-256 of the line before it in `prev` (`"genesis"` for the first), and is signed with HMAC-SHA256 including `prev` (`sig`). The key is `receipts.key_file`, or `~/.parism/receipts/receipts.key`, created with 32 random bytes (mode 0600) on first use. The chain and signature catch lines edited, removed or inserted by anyone without the key. A process running as the same user can read the auto key, though. Where an agent also has a plain shell and receipts must be trusted, put `receipts.key_file` where the agent cannot read it (a CI secret, for example).

```bash
parism receipts verify        # finds edited lines, removed or inserted lines, unsigned or wrongly signed lines
```

| Change | How it shows |
|-|-|
| One line edited | That line's signature fails and the next line's `prev` does not match |
| A middle line removed | The next line's `prev` does not match |
| A line appended without the key | Missing or wrong signature |

The chain still checks after old lines are pruned; the first line's `prev` is not checked. The key is never read from the environment or passed to child processes, and a key file inside `guard.allowed_paths` is refused. Signing prevents forgery only where the key file cannot be read except through Parism; the chain still leaves a trace of edits.

#### Pull request and CI reports

```bash
parism receipts export --format markdown          # table for a PR comment
parism receipts export --format github            # writes $GITHUB_STEP_SUMMARY and emits ::error annotations
parism receipts export --format sarif > parism.sarif
parism receipts export --format json --since 24h
```

It reports per-command run counts and last results, test and diagnostic totals, commands whose last run failed (and how many runs failed in the period), whether the latest receipt matches the current workspace, the chain and signature check, guard blocks and tokens saved. It exits 1 when a command's last run failed or the chain check failed.

A receipt does not say whether the tests check the right thing.

`results`, `receipts`, `verify`, `stats` and `hook` are read from the host config only; the same keys in a project config are dropped with a warning. A project config can only lower the two `tasks` limits.

---

## Hooks

Instead of waiting for the agent to pick an MCP tool, connect the agent CLI's shell calls and session end to Parism.

```bash
npx @nerdvana/parism hook install                      # Claude Code, .claude/settings.json of this repository
npx @nerdvana/parism hook install --scope user         # ~/.claude/settings.json
npx @nerdvana/parism hook install --client gemini      # .gemini/settings.json
```

The installer keeps the other keys and hooks of the settings file and adds `PreToolUse` (Bash), `Stop` and `SessionStart` hooks; running it again adds nothing twice. When `~/.parism/hook.config.json` does not exist it is created with the build profile, receipts on, redaction on, `allowed_paths` set to the repository, and `npx`, `node`, `vitest`, `tsc`, `pytest`, `go`, `make` and others added to the allowed commands.

| Hook | What it does |
|-|-|
| `PreToolUse` | When a Bash command is a Parism target (a command with a parser, a test runner or linter, pipe stages), rewrites it to run through `parism exec`. An allowed command with a disallowed argument (`git push`, `curl -d`) is blocked with the reason |
| `SessionStart` | Records HEAD and `state_digest` at session start under `~/.parism/sessions/` |
| `Stop` | When the workspace changed since the session started and there is no passing test or build receipt for the current state, refuses to stop and says what to do |

- A rewritten command reads like a shell run: the exit code is kept, the shorter of the parsed JSON and the raw text is printed, and test runners and linters print the parsed report.
- Lists joined with `;`, `&&` and `||` are judged piece by piece. When the lexer and guard accept every piece, they run in order with shell rules; `$?` and `${PIPESTATUS[N]}` become the previous piece's exit code, and a `cd <dir>` piece sets the directory for the next ones.
- Shell syntax the lexer does not accept (redirection, `$VAR`, `$(...)`), commands outside the allowlist, and commands on paths outside the workspace are left to the shell unchanged. Those runs leave no receipt.
- When every rewritten segment is read-only (`git status`, `ls`, `ps`, …) the hook returns `permissionDecision: "allow"` and the command runs without a prompt. Commands that touch files, processes or the network (`npm test`, `git add`, …) get no decision, so Claude Code's permission rules and mode apply to the rewritten command as usual. `"hook": { "permission": "allow" }` in the hook config runs every rewritten command without asking; `"ask"` asks every time.
- With `verify.commands`, the Stop verdict uses those commands' receipts. Without it, it uses the latest test or build run (test runners and linters, `npm test`, `npm run test|build|lint|check…`, `make`, `cargo test|build|check`, `go test|build|vet`) in the current workspace state.

Checked with 7 real Claude Code (`haiku`) sessions:

| Session | Stop verdict |
|-|-|
| Answers a question, changes no file | passes |
| Edits, runs the tests and they pass (`npm test 2>&1 \| tail -n 30`) | passes |
| Adds a function and a test, checks with `npm test` | passes |
| Edits, then tries to finish as told not to run tests | blocked all 9 times |
| Runs tests, edits again, tries to finish | blocked all 9 times |
| Tries to finish with a failing test | blocked; the agent fixed the failure, re-ran and passed |
| Edits, runs the tests in a `;`-joined shell command | passes |

Claude Code ends the turn after the same Stop hook blocks 9 times in a row.

### parism stats

```bash
parism stats --since 7d
parism stats --json --price 3
```

Every run appends the command name, outcome class, raw and delivered bytes with token estimates, and the number of redacted spans to `~/.parism/stats/events.jsonl`; arguments and output text are not stored. The command shows tokens saved against sending the raw output and the estimated cost, results kept automatically, re-queries answered without re-running, redactions, commands the guard blocked, refused shell syntax, commands the hook rewrote or blocked, and Stop gate verdicts. Turn it off with `"stats": { "enabled": false }` in the host config.

### parism doctor

Checks the configuration and installation and says what to fix: redaction off, settings such as `output_patterns: []` that disable it, no path limit, whether the receipt signing key is usable, whether the native regex engine is present, allowed commands that are not installed, hook installation, and commands and shell syntax refused most in the last 30 days. It exits 1 when a `FAIL` item is found.

---

## Configuration

`prism.config.json` controls the guard and parsers.

```
 ~/.parism/prism.config.json      global
           │  overridden by
 <cwd>/prism.config.json          project (cannot widen the guard*)
           │  overridden by
 PARISM_* environment variables
           ▼
     effective config
```

\* To let project config widen the guard, set `"trust_project_config": true` in the global config.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps"],
    "allowed_paths": ["/home/user/projects"],
    "profile": "readonly",
    "timeout_ms": 10000,
    "max_output_bytes": 102400,
    "max_items": 500,
    "default_page_size": 100,
    "block_patterns": [";", "$(", "`", "&&", "||", ">", ">>", "<", "|"],
    "command_arg_restrictions": {
      "node": { "blocked_flags": ["-e", "--eval", "-r", "--require", "-p", "--print", "--input-type"] },
      "npx":  { "blocked_flags": ["--yes", "-y"] }
    },
    "secrets": {
      "env_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"],
      "output_redaction_enabled": false
    }
  },
  "parsers": {
    "strict_schemas": false,
    "external_isolation": "worker",
    "external_time_limit_ms": 500,
    "external_memory_limit_mb": 128
  },
  "telemetry": {
    "enabled": false
  },
  "results":  { "max_entries": 16, "ttl_ms": 300000 },
  "output":   { "include_raw": false, "auto_retain_rows": 100, "preview_rows": 50 },
  "mcp":      { "surface": "core" },
  "stats":    { "enabled": true, "max_entries": 20000 }
}
```

| Key | Description |
|---|---|
| `guard.allowed_paths` | Empty means no path restriction |
| `guard.profile` | `"readonly"` (default) allows read-only subcommands. `"build"` and `"ci"` add build and test commands such as `npm run`, `npm test`, `cargo build`, `terraform plan` and `docker compose ps`, and local git writes. They run project code, so enable them only for repositories you trust |
| `guard.allow_git_remote_write` | When `true`, `git push` and `git remote add`·`set-url`·`remove` are allowed in the build and ci profiles. An untrusted project config cannot enable it |
| `guard.workspace_executables` | When `true`, an executable given by path (`./configure`, `/work/build/app`) runs even if it is not in `allowed_commands`. It works only under the build profile, and the real file behind any symlink must be inside `allowed_paths`. Default `false`; an untrusted project config cannot enable it |
| `guard.command_arg_restrictions` | Merged with the defaults. Overriding some commands keeps the default limits for the rest |
| `guard.command_policies` | Override per-command subcommand and flag rules |
| `guard.secrets.env_patterns` | Environment variables with matching names are removed from the child process |
| `guard.secrets.output_redaction_enabled` | When `true`, values matching `output_patterns` are replaced with `[REDACTED]` in `stdout.raw`, `stderr.raw`, `stdout.parsed`, failure messages, kept results (`query_result`, `explain_result`, continuation) and service output. In parsed results, values of fields whose names contain `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY` and similar are masked too |
| `guard.secrets.output_patterns` | Omitted means the default patterns: OpenAI·Anthropic·GitHub·GitLab·AWS·Slack tokens, `Bearer` headers, `user:password@` in URLs, values of assignments whose names mean a secret (`DB_PASSWORD=…`, `"api_key": "…"`), JWTs and PEM private key headers. Set `[]` to disable |
| `parsers.strict_schemas` | When `true`, parsed results are validated against Zod schemas |
| `telemetry.enabled` | When `true`, responses include per-stage timings and `describe` shows per-command stats. Nothing is sent externally |
| `output.include_raw` | When `true`, `stdout.raw` is returned even when parsing succeeded |
| `output.auto_retain_rows`, `output.preview_rows` | Above `auto_retain_rows` rows, the first `preview_rows` rows and a `result_id` are returned. `0` turns it off |
| `mcp.surface` | `"core"` (default) is the three tools `run`, `query_result`, `describe`; `"full"` is the nine 2.x tools |
| `mcp.max_response_bytes` | Upper bound for one `run` response JSON (default 40000). Above it `stdout.raw` is cut at a line boundary and `_hint` points to `options.page`. MCP clients drop larger tool results (Claude Code defaults to 25,000 tokens) |
| `stats` | Usage records for `parism stats`. Read from the host config only |
| `tasks.allow_persistent_services` | When `true`, `persist` of `mode: "service"` is accepted. Host config only |

`node`, `npx`, and `yarn` must be added to `allowed_commands` explicitly and only work under the build profile. `npx` always gets `--no --`, so packages that are not installed are not downloaded and every following flag reaches the tool.

### Environment variables

| Variable | Target | Format |
|---|---|---|
| `PARISM_ALLOWED_COMMANDS` | `guard.allowed_commands` | Comma-separated |
| `PARISM_ALLOWED_PATHS` | `guard.allowed_paths` | Comma-separated |
| `PARISM_TIMEOUT_MS` | `guard.timeout_ms` | Integer |
| `PARISM_MAX_OUTPUT_BYTES` | `guard.max_output_bytes` | Integer |
| `PARISM_MAX_ITEMS` | `guard.max_items` | Integer |
| `PARISM_DEFAULT_PAGE_SIZE` | `guard.default_page_size` | Integer |
| `PARISM_STRICT_SCHEMAS` | `parsers.strict_schemas` | `true` or `1` |
| `PARISM_ADAPTIVE_FORMAT_JSON` | `parsers.adaptive_format_threshold.json` | Integer |
| `PARISM_ADAPTIVE_FORMAT_COMPACT` | `parsers.adaptive_format_threshold.compact` | Integer |
| `PARISM_ADAPTIVE_FORMAT_JSON_NO_RAW` | `parsers.adaptive_format_threshold.json_no_raw` | Integer |
| `PARISM_TELEMETRY_ENABLED` | `telemetry.enabled` | `true` or `1` |

---

## Using it as a library

Call Parism directly from Node.js, without MCP.

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine();
const result = await engine.run("ls", { args: ["-la"] });
console.log(result.stdout.parsed);
```

- `createEngine()` reads the same config layers as the MCP server and loads registered external parsers. To use one specific file, call `createEngine({ configPath: "…" })`.
- `run` options are those of the MCP `run` (`command`, `args`, `cwd`, `select`, `where`, `include_raw`, `contract_version`, …).
- `engine.describe("git")` shows details for a single command.

### Agents that compose commands in code: `@nerdvana/parism/sdk`

Instead of many tool round trips, run commands inside a short script and use typed values directly.

```typescript
import { sh } from "@nerdvana/parism/sdk";

const status = await sh.git.status();                       // ShResult<GitStatus>
console.log(status.data?.modified);

const busy = await sh.ps({ where: [{ field: "cpu", op: "gt", value: 5 }], select: ["pid", "command"] });
const tests = await sh.vitest.run();                        // report with attribution on every failure
for (const f of tests.data?.failures ?? []) console.log(f.file, f.line, f.attribution);

const count = await sh.exec<{ count: number }>("git log --oneline | wc -l");
```

| Function | Result type |
|-|-|
| `sh.exec(command)`, `sh.run(cmd, args)` | The given type (`unknown` by default) |
| `sh.git.status()`, `log({ n })`, `diff({ staged })`, `branch()` | `GitStatus`, `{ commits: GitCommit[] }`, `GitDiffResult`, `{ branches }` |
| `sh.ps(query)`, `sh.ls(dir, query)`, `sh.df(query)`, `sh.docker.ps(query)` | Row array results |
| `sh.vitest.run()`, `sh.jest.run()`, `sh.cargo.test()` | `AttributedTestReport` |
| `sh.tsc.check()`, `sh.eslint.lint(paths)`, `sh.cargo.build()` | `AttributedDiagnosticReport` |
| `sh.query(result_id, query)` | Query a kept result |

`ShResult` is `{ ok, exitCode, data, stdout, stderr, failure?, result_id?, envelope }`. Guard denials and execution failures are `ok: false` results, not exceptions. Set the config file and default working directory with `createShell({ configPath, cwd })`.

---

## Custom parsers

You can attach a parser to any command that lacks one. Parism is ESM-only and its schemas use zod 4.

```bash
npm install @nerdvana/parism zod@^4
# package.json needs "type": "module"
```

```
 capture ──▶ init-parser ──▶ write expected ──▶ test ──▶ add ──▶ inspect
 (save output) (scaffold)    (human-reviewed)  (replay)  (register) (compare tokens)
```

```bash
parism capture "htop -b -n 1"   # 1. save real output as a fixture
parism init-parser htop          # 2. scaffold a parser pack
# 3. write the expected values and reviewed_by into the fixture by hand
parism test ~/.parism/fixtures   # 4. replay saved output through the parser and see differences
parism add ./htop                # 5. register; usable right away, no restart
parism inspect "htop -b -n 1"    # 6. compare raw / parsed / compact output and token counts
```

Registered packs are stored in `~/.parism/parsers/` and loaded automatically when the server starts.

### ParserPack interface

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* return structured result */ },
  schema: { /* Zod schema */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
  acceptedFlags: { "-a": "bool", "-n": "value" }, // optional: verified flags; anything else is unsupported_format
  acceptedPositionals: { max: 1 },                // optional: positional argument rule
  supports: (args) => args.length < 4,            // optional: extra support condition
  headerLines: 1,                                 // optional: number of header lines
  noise: /^Total /,                               // optional: non-data lines
  rowsKey: "items",                               // optional: key of the row array
};

export default pack;
```

### Fixtures and regression checks

```console
$ parism capture "ls -l src"
Fixture saved: ~/.parism/fixtures/ls-20261005-163909.json

$ parism test ~/.parism/fixtures
fixture 4개
  검토된 기대값 1개 중 일치 0 · 변화 1
  미검토 기대값 3개 (사람이 검토해야 계약이 된다)
  매니페스트 오류 0개
  ...
  ls-20261005-163909  (ls)
  [parsed] 10건
    /entries/0/name  value  기대 "WRONG" → 실제 "cli"
```

The report lists each changed path with the expected (`기대`) and actual (`실제`) value.

Write a fixture's expected values in this form:

```json
"expected": {
  "parsed": { "entries": [ … ] },
  "reviewed_by": "name",
  "note": "why this value is correct"
}
```

- Capture masks secrets, home paths, and argument values such as `--token=`, and records what it masked in `redactions`.
- Expectations without `reviewed_by` are treated as proposals and are not counted as failures.
- Comparison is exhaustive. If you write only some fields, every other field is reported as `extra`, so write the expectation in the same shape as the actual parsed result.
- `parism test` never re-runs commands and never rewrites expectations.
- Provenance expectations check only the pointers you write. Set `evidence.exhaustive: true` for a full comparison.

The manifest format is in [SPECIFICATION.md](SPECIFICATION.md) §5.2.4.

### parism eval

Checks in three layers whether commands behave as expected on this host.

| Layer | What it checks |
|---|---|
| `execution` | Whether the command actually ran. Separates guard blocks (`blocked`) from execution failures |
| `parse` | Whether output was read as structure. Separates "no parser" from parse failures |
| `task` | Whether the task was achieved. A task looking for something absent succeeds only when nothing is found |

```bash
parism eval                    # all scenarios
parism eval execution-parse    # one scenario
parism eval --verbose          # print every item
```

Exit code is 1 if any item misses its expectation. Items without an expectation are not counted.

### External parser isolation

Each registered pack runs in its own worker thread (`parsers.external_isolation: "worker"`).

- If a call exceeds `external_time_limit_ms` (default 500 ms), the worker dies, or the V8 heap exceeds `external_memory_limit_mb` (default 128 MB), the result reports `parser_exception`. For a backoff period that starts at 2 seconds and grows up to 30 seconds, that pack fails immediately while the server keeps running.
- `parse()` must return a structured-cloneable value. Functions, Promises, or Symbols produce `parser_exception`.
- `console` output inside a pack goes to stderr.
- Cloning costs about 0.1 ms per call for 20 lines of input and about 1.6 ms for 500 lines.
- To run packs on the main thread, put `"parsers": { "external_isolation": "none" }` in the global config.

Worker isolation contains faults; it is not a security sandbox. Workers have the same file, network, and environment access as the server. If you must use untrusted packs, run all of Parism inside a container or VM.

### CLI commands

| Command | Description |
|---|---|
| `parism` | Run the MCP server (stdio) |
| `parism capture "<command>"` | Run a command and save the sanitized output as a fixture |
| `parism init-parser <name>` | Scaffold a parser pack (`parser.ts`, `schema.json`, `fixtures/`) |
| `parism test [dir]` | Replay fixtures offline and report differences. Exit code 1 if any fixture is broken |
| `parism add <path>` | Register a parser pack in `~/.parism/parsers/` |
| `parism inspect <command> [args...]` | Compare raw / parsed / compact output with token counts |
| `parism eval [scenario]` | Judge host behavior in three layers |
| `parism receipts check` | Exit 0 only if each required command has a passing, fresh receipt |
| `parism receipts list` | Show recent receipts |
| `parism receipts verify` | Check the receipt file's hash chain and signatures |
| `parism receipts export` | Summary for PRs and CI (`--format markdown\|github\|sarif\|json`) |
| `parism exec -- "<command>"` | Run one command line through the Parism engine and print it like a shell |
| `parism hook install\|pre-tool-use\|session-start\|stop` | [Hooks](#hooks) |
| `parism skill install [--scope project\|user]` | Copies the agent skill to `.claude/skills/parism` |
| `parism stats` | Tokens saved, re-queries, redactions, guard blocks, Stop gate |
| `parism doctor` | Check the configuration and installation |

Arguments passed separately, as in `parism inspect ls -l /path`, are forwarded as is. A single string, as in `parism inspect "ls -l /path"`, is split by the lexer, so quotes and backslashes work as in a shell.

---

## Upgrading from 2.x to 3.0.0

| Area | 2.x | 3.0.0 |
|---|---|---|
| MCP tools | 9 | `run`, `query_result`, `describe`. For the old tools set `"mcp": { "surface": "full" }` |
| `stdout.raw` | Always present | Empty when parsing succeeded. Use `include_raw: true` or `"output": { "include_raw": true }` |
| Large results | Everything up to `max_items` (500) | Above 100 rows: the first 50 rows, `result_id` and `_hint`. Pass `limit`, or set `"output": { "auto_retain_rows": 0 }`, for the old behavior |
| MCP response JSON | Indented by 2 for the stable contract | One line |
| Advanced `run` options (core surface) | Top-level arguments | Inside `options` (`format`, `include_raw`, `contract_version`, `retain`, `evidence`, `budget`, …) |
| Reading tasks (core surface) | `task({ task_id })` | `run({ task_id, wait_ms })`, cancel with `run({ task_id, cancel: true })` |
| `output_redaction_enabled` | `raw`, `stderr` and failure messages | Also parsed and kept results. 11 default patterns |
| Kept result lifetime | 60 seconds | 300 seconds |
| Receipts | Signed only with `key_file` | Hash chain (`prev`) and signing with an automatic key. Older unsigned receipts check as `bad_signature` |
| Usage records | None | Written to `~/.parism/stats/events.jsonl`. Turn off with `"stats": { "enabled": false }` |
| git run arguments | | `-c core.editor=true -c sequence.editor=true` added |
| `npx` run arguments | `npx --no <tool> ...` | `npx --no -- <tool> ...` |
| `systeminfo` parser | `BIOS Version` overwrote `os_version`, `OS Build Type` went into `os_build` | Exact keys; `os_build` comes from the build number in `OS Version` |

## Upgrading from 2.0.x to 2.1.0

If you only call `run` over MCP, nothing changes. Tool names are the same, and three tools were added (`explain_result`, `fetch_result`, `compare_results`). Only the following cases need code or config changes.

| Affected | Before | 2.1.0 |
|---|---|---|
| External ParserPack authors | `contract.noise`, `rowLine`, `acceptedValues` were `RegExp` on the main thread | Descriptors computed by the worker. Set `parsers.external_isolation: "none"` for the old behavior |
| Callers of `toCompact()` and `parism inspect` | Returned `unknown` | `CompactOutcome` (`{ok:true,value}` or `{ok:false,reason,message}`) |
| Configs that omit `guard.secrets.output_patterns` | Default patterns not applied | Default patterns applied. Set `output_patterns: []` to disable |
| Users of `git status --porcelain` | Target of a `failure.hint` | Supported format, parsed into an `entries` array |
| Code that stores porcelain entries as is | `xy`, `index`, `worktree`, `path`, `orig_path` | Adds a `quoted` field (set only in line mode) |

The `output_patterns` default change is a security fix. Previously, omitting the key left tokens shaped like `sk-`, `ghp_`, `AKIA`, `xoxb-`, and `glpat-` exposed even with redaction turned on.

---

## Scope

- Parism does not replace the shell. It runs existing commands and turns their output into structure. On 20 Terminal-Bench 2.0 tasks, an agent with only Bash passed 18 and an agent with Parism and no Bash passed 13 (model `haiku`, one run per task). The failed tasks needed `git` write commands or a server that keeps running after the session ends. Method and limits: [experiments/README.md](experiments/README.md), appendix T.
- Reading, continuing, or comparing retained results never re-runs a command. Expired results must be run again.
- Comparison happens only between two results the caller provides. Parism does not watch anything on a schedule.
- Token budgets are measured on the JSON Parism produces. They do not guarantee a model's actual token count.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
