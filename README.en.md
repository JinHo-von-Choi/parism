# Parism

> Refract the Shell. Every command, structured.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

An MCP server and Node.js library that lets AI agents run shell commands safely and get the results back as JSON.

Docs: [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

---

## At a glance

```json
run({ "cmd": "ls", "args": ["-la", "src"] })
```

```json
{
  "ok": true,
  "stdout": {
    "raw": "drwxr-xr-x  2 user group 4096 Mar 06 09:23 src\n",
    "parsed": {
      "entries": [
        {
          "type": "directory",
          "name": "src",
          "permissions": { "owner": "rwx", "group": "r-x", "other": "r-x" },
          "size_bytes": 4096,
          "owner": "user",
          "group": "group",
          "modified_at": "2026-03-06T09:23:00"
        }
      ]
    }
  }
}
```

- `raw` always holds the original output, unchanged.
- `parsed` holds the structure the parser extracted. It is `null` for commands without a parser.
- 43 commands have built-in parsers, and you can add your own.

Shell output is made for people. Agents that parse it themselves often trip over spaces in file names, OS-specific column order (`ps`), and headers that vary by environment (`df`). Parism detects the OS, picks the matching parser, and returns the parsed result.

---

## How it works

```
  Agent (MCP client)                 Node.js code
         │  stdio                          │  createEngine()
         ▼                                 ▼
  ┌──────────────────────────────────────────────────┐
  │                     Parism                       │
  │                                                  │
  │  1. Guard      allowlist · paths · injection     │──▶ blocked: ok=false, failure.kind="guard"
  │       │                                          │
  │  2. Executor   spawn (no shell), timeout, limit  │──▶ exec error: failure.kind="exec"
  │       │                                          │
  │  3. Redactor   mask secrets in output            │
  │       │                                          │
  │  4. Parser     OS-aware, 43 built-in + custom    │──▶ no parser: parsed=null, raw kept
  │       │                                          │
  │  5. Shaper     filter · budget · evidence        │
  │       │                                          │
  │       ├──▶ Result store (opt-in, in memory)      │
  └───────┼──────────────────────────────────────────┘
          ▼
   { ok, stdout: { raw, parsed }, failure?, review?, budget? }
```

Commands are spawned directly, without a shell. Blocks, execution failures, and parse failures never throw; they come back in the same response shape. Agents branch on `failure.kind` alone.

---

## Quick start

### 1. Install

```bash
npx @nerdvana/parism
```

Run with no arguments, it serves MCP over stdio. To build from source:

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

### 2. Register with your MCP client

Most clients accept this format as is:

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

Where each client keeps its config:

| Client | Doc |
|---|---|
| Claude Desktop | [claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

### 3. An agent's first calls

```
describe()                    check allowed commands, parsers, guard limits
   │
dry_run(cmd, args)            check the guard verdict only (no execution)
   │
run(cmd, args)                execute and get structured output
   │
   ├─ large output     ──▶ run_paged(page=N)  or  run(budget) + fetch_result
   └─ need provenance  ──▶ run(retain, evidence) + explain_result
```

---

## Tools

Seven tools are exposed once connected.

| Tool | Runs a command | Purpose |
|---|---|---|
| `run` | Yes | Default execution, with filter, budget, and evidence options |
| `run_paged` | Yes | Read large output in line-based pages |
| `describe` | No | Inspect the environment, allowed commands, and parsers |
| `dry_run` | No | Check the guard verdict ahead of time |
| `explain_result` | No | Show where a value in a retained result came from in the raw output |
| `fetch_result` | No | Read the next page of a result cut by a budget |
| `compare_results` | No | Diff two retained results |

`explain_result`, `fetch_result`, and `compare_results` only read retained results and never re-run a command. Retained results live in server process memory only, limited to 2 MiB per result, 32 MiB total, 16 results, and 60 seconds. Unknown ids, expired results, evicted results, and results never retained are rejected with distinct reasons.

### run

| Parameter | Default | Description |
|---|---|---|
| `cmd` | — | Command name |
| `args` | `[]` | Argument array |
| `cwd` | current directory | Working directory |
| `format` | `"json"` | `"json"`, `"compact"`, `"json-no-raw"` |
| `includeDiff` | `false` | Include filesystem changes before and after the run |
| `select` `where` `sort_by` `limit` `array` | — | [Filtering and projection](#filtering-and-projection) |
| `budget` | — | [Token budget](#token-budget) |
| `contract_version` | `"stable"` | `"next"` adds `review` metadata |
| `evidence` | `"none"` | `"rows"`, `"fields"`. Compute per-field source positions |
| `retain` | `false` | Keep the result in memory for follow-up tools |

Without `contract_version`, `evidence`, `retain`, or `budget`, the response has the same shape as in earlier versions.

`format: "compact"` folds list results into `schema` and `rows` to save tokens.

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

### run_paged

For commands with large output such as `ps aux`, `find`, and `grep -r`. `stdout.parsed` is always `null`; the raw output is split into line pages.

| Parameter | Default | Description |
|---|---|---|
| `page` | `0` | Zero-based page number |
| `page_size` | `100` | Lines per page. Capped at `max_page_size` (default 1000) |

`page_info` in the response carries `total_lines`, `has_next`, and `cache` (`{ hit, age_ms }`). The same command reuses its first run's output for 30 seconds.

### describe

With no arguments it returns `version`, `allowed_commands`, `available_parsers`, `guard_summary`, and `telemetry_enabled`.

With a command, as in `describe({ cmd: "git" })`, it returns only that command's details, within 2 KB.

- `policy`: subcommands, flags, and positional arguments the guard allows
- `parser`: formats the parser reads and the fields it returns
- `alternatives`: arguments to use instead of unsupported ones
- `examples`: argument examples that pass the current guard

### dry_run

Takes `cmd`, `args`, and `cwd` and returns the guard verdict without running anything.

```json
{ "would_pass": false, "reason": "command_not_allowed", "message": "Command 'rm' is not in the allowed list" }
```

The block reason is one of `command_not_allowed`, `path_not_allowed`, `injection_pattern`, or `arg_not_allowed`.

---

## Responses and failures

```
result.ok === true   ──▶ use stdout.parsed (fall back to stdout.raw if null)
result.ok === false  ──▶ branch on result.failure.kind
                           ├─ "guard"   blocked by the guard; nothing ran
                           ├─ "exec"    execution failed; stderr in message
                           ├─ "parse"   no parser (reason: "parser_not_found")
                           └─ "config"  bad filter argument (unknown_field, type_mismatch)
```

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

When a parser runs but cannot produce a result, `stdout.parse_error` records why and `raw` is returned unchanged.

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
3. **Injection patterns**: any argument containing a shell metacharacter is rejected.
4. **Per-command argument limits**: `node -e`, `node --eval`, `node --input-type`, and `npx --yes` are blocked by default.

The guard is a process-level defense, not a kernel sandbox. See [SECURITY.md](SECURITY.md) for isolating Parism in untrusted environments.

---

## Supported commands

43 commands have built-in parsers. Check each command's result fields with `describe({ cmd: "…" })`.

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
- **Build profile**: set `guard.profile` to `"build"`. `cargo` and `yarn` can run wrappers or scripts defined by the repository even for read-only subcommands, so they open only under this profile.

---

## Advanced features

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
  }
}
```

| Key | Description |
|---|---|
| `guard.allowed_paths` | Empty means no path restriction |
| `guard.profile` | `"readonly"` (default) allows read-only subcommands. `"build"` adds build and test commands such as `npm run`, `npm test`, `cargo build`, `terraform plan`, and `docker compose ps`. It runs project code, so enable it only for repositories you trust |
| `guard.command_arg_restrictions` | Merged with the defaults. Overriding some commands keeps the default limits for the rest |
| `guard.command_policies` | Override per-command subcommand and flag rules |
| `guard.secrets.env_patterns` | Environment variables with matching names are removed from the child process |
| `guard.secrets.output_redaction_enabled` | When `true`, values matching `output_patterns` are replaced with `[REDACTED]` in the output |
| `guard.secrets.output_patterns` | Omitted means the default patterns (GitHub, GitLab, AWS, Slack tokens, and more). Set `[]` to disable |
| `parsers.strict_schemas` | When `true`, parsed results are validated against Zod schemas |
| `telemetry.enabled` | When `true`, responses include per-stage timings and `describe` shows per-command stats. Nothing is sent externally |

`node`, `npx`, and `yarn` must be added to `allowed_commands` explicitly and only work under the build profile. `npx` always gets `--no`.

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
- `run` options: `args`, `cwd`, `format`, `includeDiff`, `select`, `where`, `sort_by`, `limit`, `array`, `page`, `page_size`.
- `engine.describe("git")` shows details for a single command.

---

## Custom parsers

You can attach a parser to any command that lacks one. Parism is ESM-only and its schemas use zod 3.

```bash
npm install @nerdvana/parism zod@^3
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

Arguments passed separately, as in `parism inspect ls -l /path`, are forwarded as is. A single string, as in `parism inspect "ls -l /path"`, is split on spaces, so quotes and repeated spaces are not preserved.

---

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

- Parism does not replace the shell. It runs existing commands and turns their output into structure.
- Reading, continuing, or comparing retained results never re-runs a command. Expired results must be run again.
- Comparison happens only between two results the caller provides. Parism does not watch anything on a schedule.
- Token budgets are measured on the JSON Parism produces. They do not guarantee a model's actual token count.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
