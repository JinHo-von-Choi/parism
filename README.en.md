# Parism

> Refract the Shell. Every command, structured.
>
> A safe, predictable execution gateway for AI agents.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

> Docs: [README](README.en.md) · [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

Design decisions and module layout: [SPECIFICATION.md](SPECIFICATION.md)

---

## What it is

An execution gateway that runs a shell command and hands the result back as **structured data**.

```console
$ parism run "ls -la src"
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

`raw` is always there. `parsed` is the bonus; `raw` is the safety net. Even a command with no parser comes back intact as raw text.

43 built-in parsers ship with it, and you can add your own.

---

## Why it is needed

The shell was built for humans. An agent is not a human.

`ls -la` flattens a filesystem's structure into a line of text formatted for human eyes. The agent has to turn that text back into structure: split on whitespace, decide that column one is permissions and column three is the owner, work out where the filename starts — spending tokens to reason about it. And it gets it wrong often.

The failure points are predictable.

- A filename containing a space throws off the column boundaries.
- `ps` orders its columns differently on Linux and macOS.
- The `1K-blocks` header from `df -h` varies by environment.
- macOS `stat` prints one unlabeled line, so a Linux-shaped parser gets nothing.
- A filename containing an emoji or a newline desynchronizes UTF-16 code units from byte offsets.

One mistake and the agent writes to a path that does not exist, burns a retry debugging the error, and gets it wrong again. Every retry is more tokens.

Parism removes the decoding step. It detects the OS, picks the matching parser, and returns structure.

---

## What changes

**Values carry their origin.** `ps` and `git status --porcelain` results report which bytes of the raw output each field came from.

```json
"evidence": {
  "/processes/0/command": [{ "source": "stdout", "start": 118, "end": 131, "transform": "trim" }]
}
```

After you pick a value, `explain_result` reopens the original span. A field with no origin reports `source_kind: "none"` — it says "no evidence" rather than inventing one.

**Large results explain what they dropped.** Set a token budget and the response says how many rows were left out, why, and where the next page is. It never shrinks silently.

```json
"budget": { "max_tokens": 2000, "measured_tokens": 1842, "budget_met": true },
"omission": [{ "stage": "budget", "rows_total": 206, "rows_returned": 138, "rows_omitted": 68 }]
```

**Two existing results can be compared.** `compare_results` first says whether the two are comparable; if they are, it pairs changed fields with their evidence. If they are not, it returns the reason for refusing.

```json
{ "comparable": false, "refusals": { "reasons": ["different command"] } }
```

**Nothing re-runs.** Continuations and lookups read from stored results only. An unknown id, an expired one, an evicted one, and never-retained are four distinct refusal reasons.

**Execution goes through a gate.** Commands outside the allow list do not run. Neither do paths outside the allowed roots. Secrets in output are masked by default. See [Guard](#guard--why-an-agent-gets-none-of-this-for-free) below.

---

## About token cost

One thing is worth stating plainly: **JSON is heavier than raw text.** Key names repeat on every entry.

For a 200-line `ls -la`: raw 5,044 tokens, JSON 12,204. At 500 lines: raw 12,545, JSON 30,122. Reproduce with `node experiments/token-cost.mjs --entries=200` (the default) and `--entries=500`.

So budgeting is the right move. For a one-shot lookup, taking only the fields you need beats carrying the raw text. For a result you will reopen alongside its evidence, the structure earns its keep. Parism is not a tool that saves tokens — it removes decoding work.

This repository does not measure how many percent an agent saves in misreads or retries. Unreproducible numbers do not go in the docs.

---

## 60-second demo

This is exactly what `experiments/demo-60s.mjs` produces. Reproduce with `npm run build && node experiments/demo-60s.mjs` (fixed seed).

**A budget on a 200-row listing**

```
목록 200행 중 87행 표시
예산 생략 119행
측정 18355 / 20000 토큰 (parism/approx, exact=false)
파싱 오류 0건
누락 내역: ["budget"]
  budget: reason=119 of 206 row(s) were left out to fit 14611 tokens
          total=206 returned=87 omitted=119
```

**The raw span behind a chosen value**

```
고른 값: docs (directory, 4096 바이트)
ls 필드 근거: "none"

--- 근거가 있는 파서(git status --porcelain)로 같은 장면 ---
  고른 값   "changed.ts" ( M)
  원문 구간 byte[3, 13) = "changed.ts"
  성격      verbatim
  마스킹    가려지지 않음
```

`ls` produces no field evidence, so it says `source_kind: "none"`. `ps` and `git status --porcelain` do give byte spans.

**The rest, without re-running the command**

```
이어 읽기 1회 후 206행 확보 (중복 없음: true)

모르는 id: ok=false reason=unknown_id
보관 안 함: retained=false explain=not_retained
```

Two different reasons, because they call for different next steps. **Neither re-runs the command automatically.**

**One number.** The same 87 rows cost 18,355 tokens with the raw output attached and 1,266 tokens as required fields only. The difference is the raw text. Ask for this listing with a 2,000-token budget and you get 0 rows in practice — the raw output alone exceeds the ceiling — and it still says so instead of quietly exceeding. The same listing under a 20,000-token budget returns 138 rows.

---

## Guard — why an agent gets none of this for free

`rm -rf /` is three characters long.

Agents make mistakes. They lose context, misremember paths, and generate commands nobody intended. Guard exists so a mistake does not become a disaster.

There are four layers.

**Allow list**: a command not in `allowed_commands` never runs. The process is never even spawned, and the refusal carries no explanation.

**Path restriction**: setting `allowed_paths` checks `cwd` and path arguments. Every command is checked against path-shaped values — anything containing `/`, starting with `.` or `~`, or resolving to something that exists under `cwd` (symlinks included) — and commands that take paths (`cat subdir/file`, `find src`) always have their positionals and path flag values checked. Anything outside the allowed roots is blocked. This is a guard-level defense, not a kernel sandbox.

**Injection pattern blocking**: each argument is inspected on its own. If it contains `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, or `<`, the command does not run. Checking per argument means no false positives that cross an argument boundary.

**Per-command argument restrictions**: each command can declare flags to block. `node -e`, `node --eval`, and `node --input-type` are blocked by default. So is `npx --yes`.

A blocked command returns this.

```json
{
  "ok": false,
  "guard_error": {
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  },
  "failure": {
    "kind": "guard",
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

`failure` is the authoritative field. `guard_error` is kept for backward compatibility; branch on `result.failure.kind`.

The agent receives a refusal in exactly the same shape as a normal result. Nothing throws. The pipeline does not break.

The threat model, the limits of the four layers, and isolation recommendations for untrusted environments are in [SECURITY.md](SECURITY.md).

---

## Command support

43 commands have built-in parsers. For the fields a given command returns, ask `describe({ cmd: "…" })`.

| Category | Commands | Allowed by default |
|---|---|---|
| Filesystem | `ls -l` `find` `stat` `du` `df` `tree` | yes |
| Process | `ps aux` | yes |
| Network | `ping` `curl -I` `netstat` `lsof -i` `ss` `dig` | yes |
| Text | `grep -n` `wc` `head` `tail` `cat` | yes |
| Git | `git status` `git log --oneline` `git diff` `git branch -vv` | yes |
| Deployment | `kubectl get` `docker` `gh pr list` `helm list` | yes |
| Environment | `env` `pwd` `which` | yes |
| System | `free` `uname` `id` `systemctl list-units` `journalctl` `apt list` `apt search` `brew list --versions` | yes |
| Packages | `npm list` | yes |
| Packages | `pnpm list` `yarn list` | explicit allow (`yarn` also needs the build profile) |
| Build | `terraform plan` `cargo tree` | build profile |
| Process control | `kill` | explicit allow |
| Windows | `dir` `tasklist` `ipconfig` `systeminfo` | explicit allow |

**Explicit allow** means you add it to `guard.allowed_commands` yourself. **Build profile** means you also set `guard.profile` to `"build"`. `cargo`'s query subcommands (`tree` `metadata` `search` `pkgid`) are build-profile only because they can execute the rustc wrapper the repository configures; `yarn` is the same because it can execute the `yarnPath` script the repository configures. Both run project code, so turn them on only in repositories you trust.

**A command with no parser returns `stdout.parsed: null` with `raw` untouched.** That is not a failure. `stdout.parse_error` is a separate field, filled in only when a parser throws, so a parser bug is distinguishable from having no parser.

| `parse_error.reason` | Meaning |
|---|---|
| `parser_exception` | The parser threw |
| `schema_violation` | `strict_schemas` rejected the result |
| `unsupported_format` | The parser does not handle that argument's output format |
| `unrecognized_output` | There were data lines, but nothing could be read from them |

When the command never ran, `result.failure` carries it (`kind: "exec"`, with stderr in the message) and `stdout.parse_error` stays empty. A missing parser surfaces as `result.failure.reason === "parser_not_found"` (`kind: "parse"`).

### Arguments outside a parser's format

Each parser declares the argument range it was actually verified against (accepted flags, positional rules, subcommands) as its contract. Given an argument outside that range, it does not run at all and returns `unsupported_format`. Surfacing a failure beats quietly interpreting the value wrong. `raw` is untouched, and if the output is a JSON document the native JSON passthrough fills `parsed`.

When another argument form yields the same information, it is returned alongside.

```json
{ "reason": "unsupported_format", "hint": { "args": ["log", "--format=%h %s"] } }
```

`uname -r` → `["-a"]` · `git status -s --ignored` → `["status", "--ignored"]` · `kubectl get pods -o yaml` → `["get", "pods", "-o", "json"]`. The full list is in [SPECIFICATION.md](SPECIFICATION.md) §3.2.

### JSON has a parser for free

When the command's output is itself JSON (`kubectl get pods -o json`, `docker inspect`), it lands in `parsed` without going through a parser. Guard checks and envelope wrapping apply exactly as they do otherwise. No configuration.

---

## Install

```bash
npx @nerdvana/parism
```

To build it locally:

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

---

## Library mode

Call Parism directly from Node.js, with no MCP server.

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine();
const result = await engine.run("ls", { args: ["-la"] });
console.log(result.stdout.parsed);
```

`createEngine()` loads `prism.config.json`, attaches registered external parsers, and returns a `ParismEngine`. To use a different file, pass `createEngine({ configPath: "…" })`.

Run options: `args` / `cwd` / `format` / `includeDiff` / `select` / `where` / `sort_by` / `limit` / `array`, plus `page` / `page_size` for paged output. `engine.describe("git")` returns a capability summary for one command.

Details are in [SPECIFICATION.md](SPECIFICATION.md) §1.1.

---

## MCP client setup

Parism connects over the MCP stdio protocol. Per-client setup files are in `docs/mcp-clients/`.

| Client | Setup file |
|---|---|
| Claude Desktop | [claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

Running `parism` with no arguments starts the MCP server. Once connected, seven tools are exposed. A new agent should call `describe` to learn the environment and its limits, `dry_run` to confirm the guard will pass, and then `run`.

---

## Tools

| Tool | Runs a command | When to use it |
|---|---|---|
| `run` | yes | The default. Includes budget, evidence, and filter options |
| `run_paged` | yes | When the output is large and you want it page by page |
| `explain_result` | **no** | To see where a value came from (stored results only) |
| `fetch_result` | **no** | To continue reading a result the budget cut short |
| `compare_results` | **no** | To diff two stored results |
| `describe` | no | To learn the environment before the first call |
| `dry_run` | no | To check the guard before running |

`explain_result`, `fetch_result`, and `compare_results` **never re-run a command under any circumstance.** An unknown id, an expired one, or an evicted one is reported and the call ends. Stored results live in session memory only and never touch disk (2 MiB per result, 32 MiB total, 16 results, 60-second TTL).

### run

The default tool for every command. Use it when the output is small or you need structured parsing.

| Parameter | Default | Meaning |
|---|---|---|
| `cmd` | — | Command name |
| `args` | `[]` | Argument array |
| `cwd` | current directory | Working directory |
| `format` | `"json"` | `"json"` · `"compact"` · `"json-no-raw"` |
| `includeDiff` | `false` | Include the filesystem diff. Keep it `false` in busy MCP sessions |
| `contract_version` | `"stable"` | `"next"` adds a `review` block |
| `evidence` | `"none"` | `"rows"` · `"fields"`. Computes per-field evidence |
| `retain` | `false` | Store the result in session memory to revisit later |
| `budget` | — | See "Token budget" below |
| `select` `where` `sort_by` `limit` `array` | — | See "Projection and filtering" below |

`contract_version`, `evidence`, `retain`, and `budget` are **all opt-in.** Leave them out and the response is byte-for-byte what it always was.

`format: "compact"` compresses list-shaped output into `schema` + `rows` to cut token cost.

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

#### Projection and filtering

`select` (field list), `where` (condition list), `sort_by` (`{ field, order }`), and `limit` (row count) apply only to the top-level array of the parsed result (`entries` for `ls`, `commits` for `git log`, and so on). The order is `where` → `sort_by` → `limit` → `select`, and `array` picks which array when there are several.

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

- Operators: `eq` `ne` `prefix` `contains` (strings, numbers, booleans, `null`), `gt` `gte` `lt` `lte` (numbers). Every condition must hold.
- The result gains `_summary: { total, matched, shown }` and `stdout.raw` is not sent. It is `parsed._summary` when the array is inside the result object, and `stdout._summary` when the result is the array.
- Sorting is stable, and rows with no value sort last. It composes with `format: "compact"`.
- A missing field or a type mismatch is `failure.kind = "config"` (`unknown_field`, `type_mismatch`) with raw preserved. A malformed argument never runs.
- On a 500-entry directory, `ls -l` with `select: ["name","size_bytes"], limit: 50` cuts the parsed result by 97.6% of its tokens (30,122 → 725, `parism/approx`). Reproduce with `node experiments/token-cost.mjs --entries=500`.

### run_paged

Reads large output one page at a time. Use it for `ps aux`, `find`, `grep -r`, and the like.

- `cmd` `args` `cwd` `includeDiff` — same as `run`
- `page` — zero-indexed page number (default `0`)
- `page_size` — lines per page (default 100). The ceiling is `max_page_size` (default 1000); a larger request is clamped and the requested value is kept in `page_info.requested_page_size`

The response adds `page_info.total_lines`, `page_info.has_next`, and `page_info.cache` (`{ hit, age_ms }`, reusing the first execution's result for 30 seconds). A partial listing cannot be structured, so `stdout.parsed` is always `null`.

```
1. run_paged(cmd, page=0) → read page_info.total_lines for the overall scale
2. If it is small, use it as is
3. If it is large, narrow it with grep first, then use run
4. Fetch only the pages you need with run_paged(page=N)
```

### describe

The onboarding tool. Returns the allowed commands, available parsers, guard limits, and version for the current environment.

Called without arguments it returns `version`, `allowed_commands`, `available_parsers`, `guard_summary` (`timeout_ms`, `max_output_bytes`, `max_items`, `block_patterns`, `allowed_paths`), and `telemetry_enabled`. `stats` (per-command result counts) is added only when telemetry is on.

`describe({ cmd: "git" })` returns one command's information in under 2 KB.

- `policy` — the subcommands, flags, and positional rules the guard allows, plus the policy's origin (`origin`: `default`, `build`, `config`, `none`)
- `parser` — the formats the parser handles: `requires`, `values`, `flags`, `rows_key`, `row_fields`
- `alternatives` — arguments that substitute for out-of-format ones (`{ from, args, reason }`)
- `examples` — example arguments that pass the current guard

A command that is not allowed comes back as a result carrying `failure` (`command_not_allowed`).

### dry_run

Checks the guard without running anything.

Takes `cmd` `args` `cwd` and returns `would_pass`, the refusal reason (`command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`), and a message.

```json
{ "would_pass": false, "reason": "command_not_allowed", "message": "Command 'rm' is not in the allowed list" }
```

### Evidence — `run` + `explain_result`

**Answers "which bytes of the original did this value come from?"** without running a new command.

Request `contract_version: "next"` to get the `review` block, and `retain: true` to store the result for later. Passing `evidence: "rows"` or `"fields"` also computes per-field evidence.

`review` is added alongside the existing envelope fields without changing what any of them mean.

| Field | Meaning |
|---|---|
| `result_id` | The id you pass to `explain_result`, `compare_results`, `fetch_result` |
| `parser_id` / `parser_version` / `schema_version` | The parser and schema that produced this result |
| `content_hash` | Hash of the raw output, to tell repeated executions apart |
| `source_complete` | Whether collection finished (`parse_complete` is whether parsing finished, `representation_lossless` is whether compression or transformation lost a value) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | Whether `explain_result` can reopen it |
| `warnings` | Why the result is incomplete or has no evidence |

**Completeness has three values: `true`, `false`, and `unknown`.** `unknown` exists so that an unverified claim is not stated as a false one. When a collection ceiling is hit, `source_complete` is `false` and `warnings` says so — the evidence then covers only the preserved prefix.

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived",
  "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- A span is a `[start, end)` range of UTF-8 byte offsets into the masked canonical raw output. When a parser transformed the value, `source_kind` is `derived` and the transform is named.
- **Evidence is a link to what the command printed at that moment. It is not proof that the value is true.**
- An unknown pointer returns `unknown_pointer`; an expired or evicted id fails with that fact attached. **Nothing is re-executed automatically.**

Only `ps` and `git status --porcelain` produce evidence. The rest report that absence in `warnings`.

Computing evidence changes the result's shape, which would erase the evidence pointers and the required-field calculation targets. So **asking for `evidence` or `budget` turns adaptive compaction off.** If you pass `format: "compact"` explicitly, it compacts anyway and records the reason in `warnings`.

### Token budget — `run(budget)` + `fetch_result`

**Takes a large result inside a budget and tells you what fell outside it.** The point is to keep "dropped for budget reasons" separate from "dropped because the parser failed".

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

- **A budget does not reduce runtime or collection.** It decides how much of an already-obtained result to send.
- `required_fields` are never dropped from any row, and the row identity the parser declared is kept too. **If required fields cannot fit, it fails explicitly instead of quietly sending a partial result** — a partial success is silent loss.
- A budget below the minimum envelope (about 1,200 tokens) is refused with `budget_too_small` **before** execution.

The response gains a `budget` report and an `omission` list.

- `budget` — `requested`, `measured_tokens`, `tokenizer_id`, `tokenizer_version`, `budget_met`, `tokenizer_exact`, `tokenizer_scope`
- `omission[]` — `stage` (`capture`/`parse`/`projection`/`budget`/`privacy`) and `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `next_cursor`

The **fixed tokenizers** are `parism/approx` (approximate) and `byte` (exact per character), with no new runtime dependency. An unsupported tokenizer is refused with `tokenizer_unsupported` rather than silently substituted. That guarantee covers the Parism JSON payload only — **transport, client, and model-internal tokens are not included**, which `tokenizer_scope` states.

`fetch_result(result_id, cursor, budget)` returns the next page of the same stored result **without re-executing.** Pass `continuation.cursor` through unchanged. A cursor binds the progression rules (snapshot identity, projection, policy, schema) to the position, so **a client cannot assemble an arbitrary offset.** A cursor from a different result is refused with `cursor_mismatch`, and a tampered one with `cursor_invalid`.

```
1. run(cmd, { budget: { max_tokens: 2000, overflow: "page" }, retain: true })
2. Check budget.budget_met and omission for what was dropped
3. If continuation.cursor is present, repeat fetch_result(result_id, cursor)
4. Stop when you have read it all, or tell the user about any remaining omission
```

### Semantic diff — `compare_results`

**Compares two results that already exist.** It does not run a new command, does not reach the network, and does not set up a watch loop.

Takes `base_id` and `current_id` (the `review.result_id` from `run(retain: true)`), optionally `keys`, `ignore_fields`, and `strict`. The response is `comparable`, `refusals`, `added`/`removed`/`changed`/`unchanged_count`, `ignored_fields`, `partial`, and `key_conflicts`; changed fields carry the evidence pointers from both sides.

**Zero false deletions** — if either side is incomplete (collection truncated, parser failure, representation loss), a missing row is not declared deleted; the hold is recorded in `partial.withheld_reasons`. A row whose identity could not be established is not declared added or deleted either — not finding it is not the same as it being new. Duplicate identities stop the comparison with `duplicate_identity` rather than silently dropping a row.

- Row identity rules: git uses repository identity (real path) plus the normalized path. kubernetes uses context/namespace/kind plus `metadata.uid`, and **a table listing without a uid is not enough to call two rows the same resource.** **ps does not use PID as identity and withholds the comparison** (PIDs get reused).
- **A fingerprint is not a certificate of world state.** The same fingerprint can hide a file that changed in between.
- To avoid leaking secrets, **argv is identified by hash and only masked values are displayed.** **Environment variables are recorded by name only; values are never kept.**

---

## Migration — 2.0.2 to 2.1.0

2.1.0 **does not change the meaning of any existing envelope field.** `contract_version` defaults to `"stable"`, so an existing consumer that passes no new arguments gets exactly the response it got before. Using a new feature requires naming the opt-in argument.

**But the five cases below need a code change.** They affect code that calls these APIs directly rather than going through MCP. A consumer that only calls `run` is unaffected.

| Affected | Before | Now |
|---|---|---|
| External ParserPack authors | `contract.noise` / `rowLine` / `acceptedValues` were `RegExp` on the main thread | Descriptors and `facts` computed in the worker; no `RegExp` on the main thread |
| `toCompact()` / `parism inspect` callers | Returned `unknown` | `CompactOutcome` (`{ok:true,value}` \| `{ok:false,reason,message}`) |
| Configs that omit `guard.secrets.output_patterns` | The 7 default patterns were not applied | The default patterns are used. Pass `output_patterns: []` to disable them |
| Consumers of `git status --porcelain` | Targeted by a `failure.hint` alternative-format suggestion | A supported format. An `entries` row array |
| Code that serialized porcelain entries wholesale and stored them | `xy`/`index`/`worktree`/`path`/`orig_path` | The same fields plus `quoted` (populated only in short mode). **The meaning of the path value is the same in both modes** |

The first two are not reversible. `toCompact()` callers must handle `representation_not_lossless`, and ParserPack authors who need the old behavior can set `parsers.external_isolation: "none"` in the global config to run on the main thread again.

**The `output_patterns` default change is a security matter.** Previously, omitting the key left the defaults inactive, so with redaction enabled the five synthetic secrets (sk-, ghp_, AKIA, xoxb-, glpat-) were returned verbatim.

**What does not need changing**

- MCP client setup — no tool was renamed. Three tools were added.
- Existing `run` calls — pass no new arguments and the response is what it always was.
- Built-in parser responses — unchanged except for `git status --porcelain`.

---

## Configuration

Put `prism.config.json` at the project root to control the guard.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps"],
    "allowed_paths": ["/home/user/projects"],
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
      "output_patterns": ["Bearer [A-Za-z0-9._\\-]+", "ghp_[A-Za-z0-9]+"],
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

- An empty `allowed_paths` means no path restriction. That call is yours to make.
- Environment variables matching `guard.secrets.env_patterns` are removed from the child process before execution, so running `env` does not expose them.
- `guard.secrets.output_redaction_enabled` defaults to `false`. Set it to `true` and strings matching `output_patterns` are replaced with `[REDACTED]` in the raw output. It applies before parsing, so `stdout.parsed` is unaffected.
- `command_arg_restrictions` is merged with the defaults. Overriding a few commands keeps the remaining default restrictions in place.
- `parsers.strict_schemas: true` validates each parser's result against its Zod schema and returns `failure.reason === "schema_violation"` on a violation. Default `false`.
- `telemetry.enabled: true` adds a `telemetry` field to the response envelope with per-stage timings in milliseconds and the raw output size in bytes. It also accumulates per-command result counts, surfaced through `describe` as `stats`. Nothing is sent anywhere or written to disk.

`guard.profile` defaults to `"readonly"`, which allows lookup subcommands only. Changing it to `"build"` additionally allows build and test subcommands such as `npm run`, `npm test`, `cargo build`, `terraform plan`, and `docker compose ps`. **These execute project code, so turn them on only in repositories you trust.** `node`, `npx`, and `yarn` must be added to `allowed_commands` directly and work only under the build profile; `npx` gets `--no` appended. Per-command rules are overridden with `guard.command_policies`.

**A project `prism.config.json` cannot widen the guard.** To allow that, set `"trust_project_config": true` in the global `~/.parism/prism.config.json`.

### Configuration layers and environment variables

Three layers are merged in order. Each layer overrides the one before it.

1. Global: `~/.parism/prism.config.json`
2. Project: `<cwd>/prism.config.json`
3. Environment variables prefixed `PARISM_`

Both the MCP server and library mode (`createEngine()`) use the same three layers. Passing `createEngine({ configPath })` loads only that one file.

| Environment variable | Setting | Format |
|---|---|---|
| `PARISM_ALLOWED_COMMANDS` | `guard.allowed_commands` | comma-separated list |
| `PARISM_ALLOWED_PATHS` | `guard.allowed_paths` | comma-separated list |
| `PARISM_TIMEOUT_MS` | `guard.timeout_ms` | integer |
| `PARISM_MAX_OUTPUT_BYTES` | `guard.max_output_bytes` | integer |
| `PARISM_MAX_ITEMS` | `guard.max_items` | integer |
| `PARISM_DEFAULT_PAGE_SIZE` | `guard.default_page_size` | integer |
| `PARISM_STRICT_SCHEMAS` | `parsers.strict_schemas` | `true` or `1` |
| `PARISM_ADAPTIVE_FORMAT_JSON` | `parsers.adaptive_format_threshold.json` | integer |
| `PARISM_ADAPTIVE_FORMAT_COMPACT` | `parsers.adaptive_format_threshold.compact` | integer |
| `PARISM_ADAPTIVE_FORMAT_JSON_NO_RAW` | `parsers.adaptive_format_threshold.json_no_raw` | integer |
| `PARISM_TELEMETRY_ENABLED` | `telemetry.enabled` | `true` or `1` |

---

## Custom parsers

When 43 are not enough, write your own. Two things must be in place first, or the scaffold will not compile.

```bash
npm install @nerdvana/parism zod@^3
# add { "type": "module" } to package.json — Parism is ESM-only, and ParserPack.schema is a zod 3 type
```

```bash
parism capture "htop -b -n 1"   # 1. capture the command's output
parism init-parser htop          # 2. generate the parser pack scaffold

# 3. write the expected values into the captured fixture yourself — the machine does not fill them in
#    { "expected": { "parsed": { … }, "reviewed_by": "name", "note": "why this value is right" } }

parism test ~/.parism/fixtures   # 3-1. replay it — changed paths come back as a list
parism add ./htop                # 4. register it — usable immediately, no restart
parism inspect "htop -b -n 1"    # 5. compare raw/parsed/compact side by side and count tokens
```

Registered packs are stored in `~/.parism/parsers/` and loaded automatically when the MCP server starts.

### Two ways to pass arguments

| Call | Handling | Quotes and spaces |
|---|---|---|
| `parism inspect ls -l /path` | argv mode — passed through verbatim | preserved |
| `parism inspect "ls -l /path"` | string mode — split on whitespace | **not preserved** |

In string mode, `parism inspect 'echo "hello   world"'` passes the quotes through to the child as literal characters. That is why string mode warns before it runs. Pass arguments separately to pass them exactly.

### `parism eval` — three separate verdicts

`parism eval` actually runs commands on this host to check **whether expectations were met.** It does not reduce this to a single success rate. The three layers below have different causes and are judged separately.

| Layer | What it looks at |
|---|---|
| `execution` | Whether the command **actually ran.** Separates a guard refusal from an execution failure |
| `parse` | Whether it was read as structure · **having no parser** · an explicit parse failure |
| `task` | Whether it accomplished its assignment. **A task that looks for something absent succeeds by failing** |

When the guard blocks something, it comes out separately as `execution: blocked`. **A command with no parser is not a failure** — it means Parism does not know the format, not that something went wrong. **An unsupported format does fail explicitly** — no empty result goes out quietly, and a usable alternative argument comes with it. **An item with no expected value stays out of the ratio.**

The `retry-rate` scenario measures the "stored results are never re-executed" contract directly. It stores a result in an empty temporary repository, then creates a new file; if the later-created file shows up, the command was re-run.

```bash
parism eval                    # everything
parism eval execution-parse    # one scenario
parism eval --verbose          # every observation
```

If any item deviates from its expectation, the exit code is `1`.

### A closed loop that reproduces regressions with fixtures

`parism capture` → a human writes the expected values → `parism test` → what drifted comes back as a path.

```console
$ parism capture "ls -l src"
Fixture saved: /home/you/.parism/fixtures/ls-20261005-163909.json
Exit code: 0
This fixture replays but has no expected values yet.
Add expected (and reviewed_by) by hand, then run: parism test /home/you/.parism/fixtures

# ── a human writes the expected values after checking them against the raw output ──
#   "expected": {
#     "parsed": { "entries": [ … ] },     ← list only some fields and the rest all come back as "extra"
#     "reviewed_by": "name",
#     "note": "why this value is right"
#   }

$ parism test ~/.parism/fixtures
fixture 4개
  검토된 기대값 1개 중 일치 0 · 변화 1
  미검토 기대값 3개 (사람이 검토해야 계약이 된다)
  매니페스트 오류 0개

의도치 않은 계약 변화 10건 — 이걸 확인하기 전에는 배포 판정을 하지 않는다:
  ls-20261005-163909  (ls)
  [parsed] 10건
    /entries/0/name  value  기대 "WRONG" → 실제 "cli"
    /entries/2  extra  기대 undefined → 실제 { … "name":"config" … }
    …
```

**The comparison is exhaustive.** List only some fields in the expectation and every unlisted one comes back as `extra` — nine of the ten above. **An expectation has to be written in the exact shape the parser actually returns.**

- **A capture does not store the raw output verbatim.** Secrets, home paths, and `--token=`-style argument values are masked, with what was masked recorded in `redactions`. A sensitive value keeps its shape and loses only its value — blanking it entirely would make the fixture look fabricated.
- **Without `reviewed_by`, an expected value is a proposal.** `parism test` does not count it as a contract violation. `parism test` also **never writes** expected values — auto-updating is the cheapest way to hide a regression.
- **Replaying does not re-run the command.** It uses only the stored stdout. Re-running mixes in the environment of that moment, which makes "the parser changed" and "the machine changed" indistinguishable.
- Expected evidence checks only the pointers you listed. Use `evidence.exhaustive: true` for a full comparison.

The manifest format and the full contract are in [SPECIFICATION.md](SPECIFICATION.md) §5.2.4.

### CLI commands

| Command | Description |
|---|---|
| `parism capture "<command>"` | Run a command and store its sanitized output as a fixture manifest |
| `parism init-parser <name>` | Generate a TypeScript parser pack scaffold (parser.ts + schema.json + fixtures/) |
| `parism test [dir]` | Replay a fixture set offline and report changed paths (exit 1 if any fixture is broken) |
| `parism add <path>` | Permanently register a local parser pack in `~/.parism/parsers/` |
| `parism inspect <command> [args...]` | Compare raw / parsed / compact output and count tokens |
| `parism eval [scenario]` | Judge, in three layers, whether behavior matches expectations on this host |

### The ParserPack interface

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* return a structured result */ },
  schema: { /* Zod schema */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
  acceptedFlags: { "-a": "bool", "-n": "value" }, // optional: flags that were verified to select the output format. Anything else is unsupported_format
  acceptedPositionals: { max: 1 },                // optional: positional argument rules
  supports: (args) => args.length < 4,            // optional: extra rules applied after the declarations
  headerLines: 1,                                 // optional: leading lines that are not data
  noise: /^Total /,                               // optional: line patterns that are not data
  rowsKey: "items",                               // optional: the array holding one row per data line
};

export default pack;
```

### External parser isolation

Registered packs are read and executed in a worker thread, one per pack, by default (`parsers.external_isolation: "worker"`). The server thread never executes pack modules; it receives only contract declarations, and function declarations such as `supports` and `hint` are evaluated in the worker on every call.

If a single `parse()` call (including `supports` and `hint` round trips) exceeds `external_time_limit_ms` (default 500 ms), if the worker dies, or if the V8 heap exceeds `external_memory_limit_mb` (default 128 MB), the result is reported as `parse_error.reason = "parser_exception"`. For the following backoff period (starting at 2 seconds and doubling while the failure persists, up to 30 seconds) no worker is spawned and calls fail immediately; once the period elapses, the next call spawns a worker again. The server keeps responding throughout. `strict_schemas` checking is performed by the worker against the pack's schema.

- `parse()` must return a value that survives structured clone. Functions, Promises, and Symbols are `parser_exception`.
- `parse()` cannot see the server thread's global state. Output from `console` and `process.stdout.write` inside a pack goes to stderr.
- The heap ceiling limits the V8 heap only. Memory allocated outside it, such as a `Buffer`, is not limited.
- Every call pays to clone the input and the result. That is about 0.1 ms per call for 20 lines of input and about 1.6 ms for 500 lines (`npm run benchmark:external`).
- To run on the server thread as before, put `"parsers": { "external_isolation": "none" }` in the global `~/.parism/prism.config.json`.

**Worker isolation contains defects; it is not a security sandbox.** A worker holds the server process's full privileges — files, network, child processes, environment variables. Register only packs you wrote or reviewed, and run Parism itself inside a container or VM if you need to load third-party packs you do not trust. See [SECURITY.md](SECURITY.md).

---

## What Parism is not

Parism is not a new shell. It does not replace bash. It sits on top of bash, captures the output, and structures it.

Parism is not an operating system for AI. There is one concern: when an agent issues a command, hand the result back in a form the agent can read.

Parism **does not manufacture evidence.** It can tell you which bytes a value came from, but not that the value is true. Completeness that could not be verified is `unknown`, not `false`.

Parism **does not re-run the same command to look up evidence, apply a budget, or compare results.** Those read stored results, continue reading a truncated one, and diff two results. It is not a tool that re-executes what has gone missing.

Parism **is not a watch loop.** A comparison works on two results that already exist. When to look again is the caller's decision.

Parism **does not promise an exact model token count.** The fixed tokenizers (`parism/approx`, `byte`) cover the Parism JSON payload only. Transport, client, and model-internal tokens are not included.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
