# Parism

> Refract the Shell. Every command, structured.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

---

## The Shell Was Not Designed for You

In 1969, when Ken Thompson built Unix, he assumed the output would be read by a human — specifically, a creature with eyes sitting in front of a terminal.

Half a century later, that assumption no longer holds.

An AI agent runs `ls -la` and receives its output. Then the real work begins: split on whitespace, figure out that the first column is permissions, the third is the owner, infer where the filename starts — burning tokens to reason through what a human eye processes in 0.1 seconds.

This is not translation. It is decrypting a message that was never encrypted.

---

## Why This Is a Problem

Three translations happen.

First: the kernel manages filesystem metadata as `stat` structures — `inode`, `mode`, `uid`, `gid`, `size`, `mtime`. Already perfectly structured data.

Second: `ls` flattens that structure into human-readable text. `drwxr-xr-x  2 user group 4096 Mar 06 09:23 src`. Structure collapses into string.

Third: the agent tries to reconstruct that structure from the text. Rebuilding what was just torn down.

Parism intervenes between the second and third step. It recovers what was discarded.

This has a cost. Running `ls` once looks simple, but the agent may spend dozens of inference steps parsing the output — and often gets it wrong. Edge cases, unexpected whitespace, OS-specific formatting quirks. Wrong means retry. Retry means more tokens.

---

## The Honest Truth — Tokens Cost More

When building Parism, the expectation was token savings. Structured data should be more efficient than raw text.

Benchmarks across 17 scenarios flatly contradicted that. JSON output averages 205% heavier than raw text. For `ls -la` with 200 files: raw 5,807 tokens, Parism 15,531 tokens. Nearly triple, because key names repeat with every entry. What a human eye resolves from a single header row, JSON spells out N times.

But the same benchmarks revealed something else: the disappearance of "explanation tokens." With raw text, the agent needs context — "this format has permissions in the first column, owner in the third." That context prompt shrinks by an average of 61% with Parism. JSON describes its own structure. The agent just reads keys.

And there is a crossover point. For one-shot queries — run `ls` once, done — Parism costs more tokens. But the moment that result feeds into a next step, the cost structure inverts. An agent that misreads raw text writes to a nonexistent path, debugs the failure by scanning history, retries, fails again. Tokens snowball. An agent that starts with structured data never enters that cycle.

Parism's economics live not on the invoice, but in the space where mistakes and rework used to be. The cost of reading once more is nothing compared to the cost of reading once wrong.

---

## 60-Second Demo — these numbers were actually produced by the script below

`experiments/demo-60s.mjs` produces exactly this. Reproduce with `npm run build && node experiments/demo-60s.mjs` (fixed seed). **These are measurements, not promises.**

**Scene 1 — put a budget on a 200-row list and see what was dropped**

```
200 rows in, 138 shown
68 rows dropped by the budget
measured 19987 / 20000 tokens (parism/approx, exact=false)
parse errors 0
omissions: ["budget"]
  budget: 68 of 206 row(s) were left out to fit 20000 tokens
          total=206 returned=138 omitted=68
```

The ordering matters. **How many were shown, how many were dropped, why, and whether parsing failed** each land in a different field. If the numbers do not add up you get `budget_met: false` rather than a quiet shrink.

**Scene 2 — the raw span behind a value you picked**

```
value      "changed.ts" ( M)
raw span   byte[3, 13) = "changed.ts"
kind       verbatim
masked     not masked
```

`ls` produces no field evidence, and says so with `source_kind: "none"` rather than inventing one. `ps` and `git status --porcelain` do give byte spans.

**Scene 3 — the rest, without re-running the command**

```
after 1 continuation: 206 rows recovered (no duplicates)
```

And after that:

```
unknown id:     unknown_id      ← this session never had it
not retained:   not_retained    ← never stored in the first place
```

Two different reasons, because they call for different next steps. **Neither re-runs the command automatically.**

**One number worth noting.** The same 138 rows cost 19,987 tokens with the raw output attached, and 1,995 tokens as required fields only. The difference is the raw text. That is why a budget forces you to decide *in advance* what to drop. Ask for this listing with a 2,000-token budget and you get 0 rows in practice — the raw output alone exceeds the ceiling. Even then it says so instead of quietly exceeding.

---

## What Parism Does

A prism does not destroy light. It decomposes it.

```
"drwxr-xr-x  2 user group 4096 Mar 06 09:23 src"

                    ↓  Parism

{
  "type": "directory",
  "name": "src",
  "permissions": { "owner": "rwx", "group": "r-x", "other": "r-x" },
  "size_bytes": 4096,
  "owner": "user",
  "group": "group",
  "modified_at": "2026-03-06T09:23:00"
}
```

The information does not change. The shape does. The agent no longer parses. It reads.

---

## Why This Is Better

### No More Parsing Errors

Text parsing breaks easily. `ps aux` has different column ordering on Linux and macOS. The `1K-blocks` header in `df -h` varies by environment. Filenames with spaces almost always break `ls` parsing.

In numbers: raw text parsing by agents has an average CFR (Critical Failure Rate) of 4.18%. With filenames containing spaces, it climbs to 28.6%. That means 286 out of 1,000 calls produce a wrong file listing that the agent then acts on — reading wrong files, writing to nonexistent paths, deleting the wrong thing.

macOS `stat` is a starker example. Its output format is entirely different from Linux. Linux uses labeled lines like `Size: 4096`; macOS outputs a single unlabeled line. Apply a Linux parsing pattern and accuracy drops to 0%. Parism detects the OS and selects the correct parser. The agent never needs to know the difference.

Parism's CFR is 0%. Parsers are deterministic code, not probabilistic inference. The agent receives structured data.

### Fewer Retries

When an agent misinterprets output, it re-queries, runs a second command to verify, or proceeds with bad data. All three cost tokens. Structured output reduces room for misinterpretation. The file count is not something to infer — it is `entries.length`.

### The Agent Gets Better at Everything Else

Parsing text is inference. Inference consumes cognitive resources. When the agent spends capacity decoding output formats, less remains for the actual work — analyzing code, making design judgments, deciding the next step. Structured data eliminates parsing as a task entirely. The agent reads instead of reasons, and the freed capacity flows into the work that matters.

### `raw` Is Always Preserved

Parsers can be wrong. Some commands have no parser. So Parism always keeps `raw`. `parsed` is a bonus. `raw` is the fallback. The agent can always return to the original output.

```json
"stdout": {
  "raw": "drwxr-xr-x ...",
  "parsed": { "entries": [ ... ] }
}
```

### Consistent Response Structure

Whether success or failure, `ok` and `exitCode` are always in the same place. The agent's branching logic becomes simple. Not "parse stdout to check for errors" — just `if (!result.ok)`.

### Execution Time Is Recorded

Every response includes `duration_ms`. The agent can judge whether a command is slow or fast. Useful for debugging too.

### diff Is Optional

`diff` (created/deleted/modified) is populated only when `includeDiff: true`. run/run_paged default to `includeDiff: false`, skipping snapshot cost to reduce MCP call latency.

---

## Guard — Why Not to Trust the Agent

`rm -rf /` can be written in three characters.

Agents make mistakes. They lose context, confuse paths, generate unintended commands. Guard is not about distrust — it is about designing so that agent mistakes do not become catastrophes.

There are four layers of defense.

**Command Whitelist**: Commands not in `allowed_commands` are never executed. No process is created. Rejected silently.

**Path Restriction**: When `allowed_paths` is set, Guard validates `cwd` and path args. For every command, positional args and flag values that contain `/`, start with `.` or `~`, or name an existing entry under `cwd` (including symbolic links) are checked; positional args of path-taking commands (e.g. `cat subdir/file`, `find src`) and path flag values are always checked. References outside allowed paths are blocked. This is a guard, not a kernel-level sandbox.

**Injection Pattern Blocking**: Each argument is checked individually for `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, or `<`. Per-argument checking prevents cross-boundary false positives (e.g., `["foo>", ">bar"]` is not falsely detected as `>>`).

**Per-Command Argument Restrictions**: Specific flags can be blocked per command. `node -e`, `node --eval`, and `node --input-type` are blocked by default. `npx --yes` is also blocked.

A blocked command returns this:

```json
{
  "ok": false,
  "guard_error": {
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

The agent receives the block reason in the same envelope structure as any other result. No exceptions thrown. No pipeline broken.

---

## Supported Commands — 44 Built-in Parsers

| Category | Command | Parsed Output | Default |
|---|---|---|---|
| Filesystem | `ls -l` | `entries[]`: name, type, permissions, size, modified time, owner, link target, `directory` (`-R` and multiple operands) | O |
| Filesystem | `find` | `paths[]`: list of paths | O |
| Filesystem | `stat` | `file`, `link_target`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, timestamps. `files[]` for several files | O |
| Filesystem | `du` | `entries[]`: size, path, `modified_at` (`--time`) | O |
| Filesystem | `df` | `filesystems[]`: partition, `type` (`-T`), size, usage, mount point. 1K blocks use `blocks_1k`, sizes with units (`-h`) use `size`, other block units use `size` and `block_size` | O |
| Filesystem | `tree` | `root`, `tree{}`: hierarchical node map, `total_files`, `total_dirs` | O |
| Process | `ps aux` | `processes[]`: PID, CPU%, MEM%, command, `depth` (tree output) | O |
| Process | `kill` | raw pass-through (blocked by default, add to prism.config.json to allow) | X |
| Network | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` | O |
| Network | `curl -I` | `status_code`, `headers{}`, `header_values{}` (repeated headers), `history[]` (earlier responses of `-L`) | O |
| Network | `netstat` | `connections[]`: proto, local/foreign address, state | O |
| Network | `lsof -i` | `entries[]`: PID, process name, protocol, local/remote address, state (also with `-u` user selection) | O |
| Network | `ss` | `connections[]`: netid, state, recv/send queue, local/peer address and port | O |
| Network | `dig` | `query`, `query_type` (empty without a QUESTION section), `answers[]`: type, value, TTL, `query_time_ms`. Several queries add `queries[]`, one per response | O |
| Text | `grep -n` | `matches[]`: file, line number, text, `byte_offset` (`-b`), `context` (context lines of `-A/-B/-C`). Blank matching lines (`-v`, empty pattern) are rows. The file name column of `-r` is accepted with `-n` or `-b` | O |
| Text | `wc` | `entries[]`: count and filename for one counter flag; with no counter flag or several, the chosen columns of `lines`, `words`, `chars`, `bytes`, `max_line_length` and the filename. Filenames keep their spaces. `--total=only` (one counter flag) gives `total` | O |
| Text | `head`, `tail`, `cat` | `lines[]` | O |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]`, `renamed[]`, `ignored[]`, `unmerged[]`, `detached` | O |
| Git | `git log --oneline` | `commits[]`: hash, message, `refs[]` (full ref names of `--decorate=full`), `author`, `date` (`--format=%h%x09%an%x09%aI%x09%s`) | O |
| Git | `git diff` | `files_changed[]`, `files[]`: path, status, old_path, binary, hunks | O |
| Git | `git branch -vv` | `branches[]`: name, current, upstream, ahead/behind (`null` when the upstream is gone), `upstream_gone`, `detached`, `points_to` | O |
| DevOps | `kubectl get pods`, `kubectl get events` | `pods[]` / `events[]`: status, restarts, reasons, messages | O |
| DevOps | `docker ps`, `docker stats --no-stream` | `containers[]`: image, status, ports, names / `stats[]`: CPU, memory, network, block I/O, pids | O |
| DevOps | `gh pr list` | `pull_requests[]`: number, title, state, author, labels | O |
| DevOps | `helm list` | `releases[]`: name, namespace, status, chart, app_version | O |
| DevOps | `terraform plan` (build profile) | `summary`: to_add, to_change, to_destroy | O |
| Env | `env` | `vars{}`: key-value map (secrets filtered) | O |
| Env | `pwd` | `path` | O |
| Env | `which` | `paths[]` | O |
| System | `free` | `mem`, `swap`: total, used, free, available (default unit KB; `*_bytes` in bytes) | O |
| System | `uname` | `kernel_name`, `hostname`, `kernel_release`, `machine`, `os` | O |
| System | `id` | `uid`, `gid`, `user`, `group`, `groups[]`: id, name | O |
| System | `systemctl list-units` | `units[]`: name, load, active, sub, description (Linux) | O |
| System | `journalctl` (short `-o` formats) | `entries[]`: timestamp, hostname (empty with `--no-hostname`), unit, pid, message (Linux) | O |
| System | `apt list`, `apt search` | `packages[]`: name, suite, version, arch, status, description (search) | O |
| System | `brew list --versions` | `packages[]`: name, version | O |
| Package | `npm list`, `pnpm list` | `dependencies[]`: name, version, depth, `deduped`, `problem` | O |
| Package | `yarn list` (build profile) | `dependencies[]`: name, version, depth | X |
| Package | `cargo tree` (build profile) | `crates[]`: name, version, path, source, depth, deduped, proc_macro | O |
| Windows | `dir` | `directory`, `entries[]`: name, type, size, modified time, `free_bytes` | X |
| Windows | `tasklist` | `processes[]`: name, PID, session, memory. CSV format supported | X |
| Windows | `ipconfig` | `hostname`, `adapters[]`: IPv4/6, subnet, gateway, DNS, MAC | X |
| Windows | `systeminfo` | `hostname`, `os_name`, memory, `hotfixes[]`, `network_cards[]` | X |

Default (O)=in DEFAULT_CONFIG. X=requires explicit allow in prism.config.json. "(build profile)" requires `guard.profile: "build"`.

Commands without a parser return `parsed: null`. `raw` is always present. When a parser throws, `stdout.parse_error` contains `{ reason: "parser_exception", message: string }` so you can distinguish "no parser" from "parser bug".

> When the command failed, or stdout is empty and only stderr has text, `result.failure` keeps the execution failure (`kind: "exec"` with the stderr text) and the parse error stays only in `stdout.parse_error`.
>
> `stdout.parse_error.reason` takes four values: `"parser_exception"`, `"schema_violation"`, `"unsupported_format"` and `"unrecognized_output"`. `unsupported_format` means the parser does not handle the output format of the given args; `unrecognized_output` means data lines were present but the parser recognized no value. "No parser found" is not a `parse_error`; it surfaces as `result.failure.reason === "parser_not_found"` (`result.failure.kind === "parse"`).

### Accepted Formats and Alternative Args

Each built-in parser declares the argument range whose output format was verified on real output (accepted flags, positional rules, subcommands) in its contract (`src/parsers/contracts.ts`). Args outside that range do not run the parser and return `unsupported_format`, so a wrong result is reported as a failure instead of being returned silently. `raw` is kept, and when the output is a JSON document the native JSON passthrough fills `parsed`.

When other args give the same information in a handled format, `result.failure.hint` (same value in `stdout.parse_error.hint`) carries `{ args, reason }`. `args` is the full argument list for the same command and passes the readonly default policy.

| Request | `failure.hint.args` |
|-|-|
| `uname -r` | `["-a"]` |
| `ls -lh` | `["-l"]` |
| `git status -s` | `["status"]` |
| `git status -s --ignored` | `["status", "--ignored"]` |
| `git log --oneline --graph` | `["log", "--format=%h %s"]` |
| `git log -n 5` | `["log", "-n", "5", "--format=%h%x09%an%x09%aI%x09%s"]` |
| `git log --oneline --decorate` | `["log", "--oneline", "--decorate=full"]` |
| `git diff --stat HEAD~1` | `["diff", "HEAD~1"]` |
| `git branch --show-current` | `["branch", "-v"]` |
| `grep -r TODO src` | `["-n", "-r", "TODO", "src"]` |
| `ps -e` | `["aux"]` |
| `systemctl status cron` | `["list-units", "--all", "cron.service"]` |
| `journalctl -o json -n 20` | `["-n", "20", "-o", "short-iso"]` |
| `kubectl get pods -o yaml` | `["get", "pods", "-o", "json"]` |
| `gh issue list` | `["issue", "list", "--json", "number,title,state,author,labels,updatedAt"]` |
| `npm ls --parseable` | `["ls", "--json"]` |

There is no `hint` when no args give the same information (`ls -li`, `ps -ef`, `grep -z`, and so on).

### Native JSON Passthrough

Commands without a dedicated parser still get JSON output passed through when the output is valid JSON (e.g. `kubectl get pods -o json`, `docker inspect`). Parism detects this and puts it in `parsed`. Guard checks and envelope wrapping apply the same. No extra configuration needed.

---

## Installation

### npx

```bash
npx @nerdvana/parism
```

### Local Build

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

---

## Claude Desktop Integration

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
`%APPDATA%\Claude\claude_desktop_config.json` (Windows)

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

Claude Code (Linux):

```json
{
  "mcpServers": {
    "parism": {
      "command": "node",
      "args": ["/path/to/parism/dist/index.js"],
      "cwd": "/path/to/parism"
    }
  }
}
```

Once connected, seven tools are exposed: `run`, `run_paged`, `describe`, `dry_run`, `explain_result`, `fetch_result`, and `compare_results`.

The agent should call `describe` first to discover allowed commands and available parsers, then use `dry_run` to pre-check guard compliance before executing with `run` or `run_paged`. The last three tools never run a command.

---

## Tools

### run

Default tool for most commands. Use when output is small or structured parsing is needed.

Parameters:
- `cmd` — command name (e.g. `ls`, `git`)
- `args` — argument array (default: `[]`)
- `cwd` — working directory (default: current directory)
- `format` — output format (`"json"` default, `"compact"`, `"json-no-raw"`)
- `includeDiff` — include filesystem diff (default: `false`). `false` skips snapshot for lower latency. Recommended for MCP.
- `contract_version` — `"stable"` (default) or `"next"`. Only `"next"` adds a `review` object (see Field evidence).
- `evidence` — `"none"` (default), `"rows"`, `"fields"`. How much field evidence to compute. Use with `contract_version: "next"`.
- `retain` — keep the result in session memory so `explain_result` can revisit it. Use with `contract_version: "next"`.
- `budget` — `{ max_tokens, tokenizer, required_fields, overflow }`. Fits the response into a budget and reports what was dropped (see Token budget).
- `select`, `where`, `sort_by`, `limit`, `array`: server-side projection and filtering, see below.

**The four new arguments (`contract_version`, `evidence`, `retain`, `budget`) are all opt-in.** Without them the response carries no new fields.

#### Projection and filtering

`select` (field names), `where` (conditions), `sort_by` (`{ field, order }`) and `limit` (row count) apply only to the top-level array of the parsed result (`entries` for `ls`, `commits` for `git log`, and so on), in the order `where`, `sort_by`, `limit`, `select`. When the result has several arrays, pick one with `array`.

```json
{
  "cmd": "ls", "args": ["-l"],
  "where":   [{ "field": "type", "op": "eq", "value": "file" }, { "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" },
  "limit":   10,
  "select":  ["name", "size_bytes"]
}
```

- Operators: `eq`, `ne` (string, number, boolean or `null`), `prefix`, `contains` (string, case-sensitive), `gt`, `gte`, `lt`, `lte` (number). All conditions must hold.
- The result carries `_summary: { total, matched, shown }` and omits `stdout.raw`. The summary is `parsed._summary` when the array sits inside the result object, or `stdout._summary` when the result itself is an array.
- Sorting is stable and rows without the field go last. Works with `format: "compact"`; the adaptive format thresholds see the reduced row count.
- An unknown field or a comparison on the wrong type returns `failure.kind = "config"` (`unknown_field`, `type_mismatch`) and keeps raw. Malformed arguments are rejected before execution.
- For `ls -l` on a 500-entry directory, `select: ["name","size_bytes"], limit: 50` cuts the response from 28,609 to 1,066 tokens (96%, default config, gpt-tokenizer).

### run_paged

Use for large stdout (`ps aux`, `find`, `grep -r`).

Parameters:
- `cmd`, `args`, `cwd` — same as `run`
- `page` — 0-indexed page number (default: `0`)
- `page_size` — lines per page (default: `default_page_size`, 100 by default)
- `page_size` limit: `max_page_size` (1000 by default). Larger requests are reduced to it and the request is kept in `page_info.requested_page_size`
- `includeDiff` — include filesystem diff (default: `false`)

Extra fields:
- `page_info.total_lines` — total line count
- `page_info.has_next` — whether next page exists
- `page_info.cache` - `{ hit, age_ms }`. Later pages reuse the first run's result for 30 seconds
- `stdout.parsed` — always `null` (partial output cannot be safely parsed)

### describe

Agent onboarding tool. Returns allowed commands, available parsers, guard limits, and version info.

Parameters:
- `cmd`: optional. When given, returns only that command's capability summary (below).

Response:
- `version` — Parism package version
- `allowed_commands` — commands permitted by guard
- `available_parsers` — registered parser names
- `guard_summary` — `timeout_ms`, `max_output_bytes`, `max_items`, `block_patterns` (full array), `allowed_paths`
- `telemetry_enabled` — whether telemetry is active
- `stats`: only when telemetry is enabled. Outcome counts per command

Call this first when the agent encounters Parism for the first time.

`describe({ cmd: "git" })` returns one command's details in at most 2 KB, to check before a retry caused by a guard denial or an unsupported format.
- `policy`: subcommands, flags and positional rule the guard allows, and where the policy comes from (`origin`: `default`, `build`, `config`, `none`)
- `parser`: formats the parser handles. `requires` (at least one needed), `values` (value patterns), `flags`, `rows_key`, `row_fields`, and the same shape per subcommand
- `alternatives`: arguments that replace out-of-format ones (`{ from, args, reason }`)
- `examples`: example arguments that pass the current guard
- Name lists are space-separated strings. A command that is not allowed returns a result with `failure` (`command_not_allowed`).

### dry_run

Guard pre-check tool. Validates whether a command would pass guard without executing it.

Parameters:
- `cmd` — command name (e.g. `rm`, `git`)
- `args` — argument array (default: `[]`)
- `cwd` — working directory (default: current directory)

Response:
- `would_pass` — whether guard would allow execution
- `reason` — block reason (`command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`) or `null`
- `message` — detailed block message or `null`

Example: `dry_run("rm", ["-rf", "/"])` → `{ would_pass: false, reason: "command_not_allowed", message: "..." }`

### Field evidence — `run(contract_version: "next")` + `explain_result`

**Answers "where in the raw output did this value come from" as a byte span.** It never runs a command.

Three new `run` arguments. **All opt-in, all off by default** — without them the response is exactly what it was.

- `contract_version` — `"stable"` (default) or `"next"`. Only `"next"` attaches `review`.
- `evidence` — `"none"` (default), `"rows"`, `"fields"`. Anything other than `"none"` also needs `contract_version: "next"`.
- `retain` — keep the result in session memory so `explain_result` can revisit it. Also needs `contract_version: "next"`.

`review` sits beside the existing envelope fields and changes none of their meanings.

| Field | Meaning |
|---|---|
| `result_id` | the id you pass to `explain_result`, `compare_results`, `fetch_result` |
| `parser_id` / `parser_version` / `schema_version` | which parser and schema produced this |
| `content_hash` | hash of the raw output, to tell repeats apart |
| `source_complete` | did capture finish (1. `parse_complete`: did parsing finish. 2. `representation_lossless`: did compression or conversion lose values) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | can `explain_result` still see it |
| `warnings` | why it is incomplete, or why there is no evidence |

**Completeness takes three values: `true`, `false`, and `unknown`.** `unknown` exists so that "not confirmed" is not reported as "false". When the capture limit is hit, `source_complete` is `false` and `warnings` says so — evidence covers the retained prefix only.

`explain_result(result_id, pointer)` takes a JSON Pointer such as `"/processes/0/pid"` and returns the value plus its evidence.

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived", "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- Spans are UTF-8 byte offsets `[start, end)` into the **masked canonical output**. When the parser converted the value, `source_kind` is `derived` and the conversion is named.
- **Evidence links to what the command printed at that moment. It is not proof that the value is true.**
- An unknown pointer returns `unknown_pointer`; an expired or evicted id fails saying so. **Nothing is re-executed automatically.**

`ps` and `git status --porcelain` produce evidence. Other parsers report the absence in `warnings` rather than inventing it.

**Asking for evidence or a budget turns adaptive compact off.** Both rewrite the result shape, which would erase what evidence pointers and required fields refer to. If you set `format: "compact"` explicitly it still compresses, and the reason is listed in `warnings`.

### Token budget — `run(budget)` + `fetch_result`

**Get a large result inside a budget and still know what was dropped.** The point is to keep "dropped for budget reasons" separate from "dropped because the parser failed".

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

- **A budget does not reduce execution time or how much is captured.** It decides how much of what you already have to send out.
- `required_fields` survives in every returned row, as do the row identity fields the parser declares. **If a required field cannot fit, parism fails explicitly instead of quietly sending a partial result** — partial success is silent loss.
- A budget too small for the minimal envelope (about 1,200 tokens) is refused **before execution** with `budget_too_small`.

The response gains a `budget` report and an `omission` list.

- `budget` — `requested`, `measured_tokens`, `tokenizer_id`, `tokenizer_version`, `budget_met`, `tokenizer_exact`, `tokenizer_scope`
- `omission[]` — `stage` (`capture`/`parse`/`projection`/`budget`/`privacy`) with `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `next_cursor`

The **fixed tokenizers** are `parism/approx` (an estimate) and `byte` (exact by character count). No new runtime dependency. An unsupported tokenizer is refused with `tokenizer_unsupported` rather than silently substituted — an estimate is never packaged as an exact budget. This promise holds for the parism JSON payload only; it does **not** cover transport, client, or model-internal tokens (`tokenizer_scope` says so).

`fetch_result(result_id, cursor, budget)` returns the next page of a retained result **without re-running the command**. Pass the `continuation.cursor` through unchanged. The cursor binds the snapshot, projection, and policy, so **a client cannot assemble an arbitrary offset** — another result's cursor gives `cursor_mismatch`, a tampered one gives `cursor_invalid`. An expired or evicted id says so and is never re-run.

```
1. run(cmd, { budget: { max_tokens: 2000, overflow: "page" }, retain: true })
2. check budget.budget_met, read omission to see what was dropped
3. while continuation.cursor: fetch_result(result_id, cursor)
4. stop when done, or tell the user what omission still reports
```

### Semantic diff — `compare_results`

**Compares two results that already exist.** It never runs a command, never connects anywhere, never polls.

Parameters: `base_id`, `current_id` (from `run(retain=true)`), optionally `keys`, `ignore_fields`, `strict`.

Response: `comparable`, `refusals`, `added`/`removed`/`changed`/`unchanged_count`, `ignored_fields`, `partial`, `key_conflicts`. Field changes carry the before and after evidence pointers.

**Zero false deletions** — when either side is incomplete (capture truncated, parser failed, representation lossy) a missing row is never called a deletion; it becomes a hold in `partial.withheld_reasons`. Rows whose identity could not be established do not become "added" or "removed" either: not finding something is not evidence that it appeared. Duplicate identity stops the comparison with `duplicate_identity` instead of quietly dropping a row.

- Row identity rules: git uses repository identity (real path) plus normalized path. Kubernetes uses context/namespace/kind plus `metadata.uid`, and **a table without uid is not enough to call it the same resource**. **ps is withheld rather than compared on PID alone** (PIDs get reused).
- **A fingerprint is not a certificate of world state.** The same fingerprint does not mean nothing changed in between.
- Secret safety: **argv is identified by hash and only masked values are shown**. **Environment variables are recorded by name only — never their values** — and names are not part of the identity key.

### Tool summary

| Tool | Runs a command | When |
|---|---|---|
| `run` | yes | default; takes `contract_version`, `evidence`, `retain`, `budget` |
| `run_paged` | yes | large output, page by page |
| `explain_result` | **no** | check where a value came from (retained copy only) |
| `fetch_result` | **no** | continue a budget-truncated result (retained copy only) |
| `compare_results` | **no** | see what changed between two retained results |
| `describe` | no | learn the environment first |
| `dry_run` | no | check guard compliance before running |

**`explain_result`, `fetch_result`, and `compare_results` never re-run a command under any circumstance.** An unknown, expired, or evicted id is reported and that is all. Storage is session-memory TTL/LRU (2MiB per result, 32MiB total, 16 results, 60s). Nothing is written to disk.

---

## Migration from 2.0.2

2.x **does not change the meaning of any existing envelope field.** `contract_version` defaults to `"stable"`, so a consumer that passes none of the new arguments gets exactly the previous response. New features require explicitly opting in.

**Cases that need a code change (breaking)**

| Audience | Before | Now | How to keep the old behaviour |
|---|---|---|---|
| External ParserPack authors | `contract.noise`/`rowLine`/`acceptedValues` are `RegExp` on the main thread | descriptors and `facts` computed in the worker. No `RegExp` on the main thread | set `parsers.external_isolation: "none"` in global config |
| `toCompact()` / `parism inspect` callers | returns `unknown` | returns `CompactOutcome` (`{ok:true,value}` \| `{ok:false,reason,message}`) | — (reverting is not the fix; handle `representation_not_lossless`) |
| Configs that omitted `guard.secrets.output_patterns` | default `[]`, so the 7 default patterns were never used | no default; omitting uses the default patterns | set `output_patterns: []` explicitly |
| Consumers of `git status --porcelain` | an `failure.hint` "try this format instead" target | a supported format, parsed into an `entries` row array | — |
| Code serializing porcelain entries wholesale | `xy`/`index`/`worktree`/`path`/`orig_path` | same fields plus `quoted` (only set in line mode). **The meaning of `path` is identical in both modes** | — |

**The `output_patterns` default change is security-relevant.** Previously, leaving the key out made redaction effectively off, so with redaction enabled all five synthetic secrets (`sk-`, `ghp_`, `AKIA`, `xoxb-`, `glpat-`) came back untouched. Now omitting the key uses the default patterns, and only an explicit `[]` disables them.

**What does not need migrating**

- MCP client configuration — no tool was renamed. Three tools were added.
- Existing `run` calls — without the new arguments the response is unchanged.
- The 44 built-in parsers — unchanged except `git status --porcelain`.

---

## Configuration

Place `prism.config.json` in the project root to control Guard behavior.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps", "kubectl", "docker", "gh", "terraform", "helm", "cargo", "systemctl", "journalctl", "apt", "brew"],
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
      "env_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"]
    }
  },
  "telemetry": {
    "enabled": false
  }
}
```

`allowed_paths` being empty means no path restriction. That decision is yours.

`guard.secrets.env_patterns` strips matching environment variables from child processes before execution. The `env` command will not expose them. The legacy `env_secret_patterns` key was removed in 2.0.0; if present it is ignored with a warning on stderr.

`parsers.external_isolation` (`"worker"` by default, or `"none"`), `parsers.external_time_limit_ms` (default 500) and `parsers.external_memory_limit_mb` (default 128) control how external parser packs run (see "External Parser Isolation" below). Set them in the global config; an untrusted project config cannot disable isolation or raise the limits.

`guard.profile` defaults to `"readonly"`, which allows read-only subcommands only. `"build"` additionally allows build and test subcommands such as `npm run`, `npm test`, `cargo build`, `terraform plan` and `docker compose ps`. These run project code, so enable it only for repositories you trust. `cargo` query subcommands (`tree`, `metadata`, `search`, `pkgid`) also require the `build` profile, since they can run a rustc wrapper configured by the repository. `node`, `npx` and `yarn` must be added to `allowed_commands` explicitly and work only under the `build` profile; `npx` runs with `--no`, so only locally installed binaries run. Override per-command rules with `guard.command_policies`. A project `prism.config.json` cannot widen the guard; to allow that, set `"trust_project_config": true` in the global `~/.parism/prism.config.json`.

The `prism.config.json` in the repository is an example and is not included in the npm package.

`command_arg_restrictions` is deep-merged with defaults. Overriding one command does not remove restrictions for others.

`telemetry.enabled` set to `true` adds a `telemetry` field to every response envelope, including per-stage timing (`guard_ms`, `exec_ms`, `parse_ms`, `redact_ms`, `total_ms`) and `raw_bytes`. Default `false`; opt-in. It also keeps in-process outcome counts per command (`parsed`, `unsupported_format`, `unrecognized_output`, `parser_exception`, `schema_violation`, `parser_not_found`, `guard` and `exec` by reason), shown as `stats` in `describe`. Nothing is sent or stored.

### Config Layers and Environment Variables

Configuration merges three layers in order; later layers override earlier ones.

1. Global: `~/.parism/prism.config.json`
2. Project: `<cwd>/prism.config.json`
3. Environment: `PARISM_`-prefixed variables

Both the MCP server and library mode (`createEngine()`) use the same three-layer merge. `createEngine({ configPath })` loads only the specified file.

| Environment variable | Target setting | Format |
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

## Custom Parsers -- Build and Use Immediately

When 44 built-in parsers are not enough, build your own. Parism v0.5.0 includes a CLI toolkit.

### Create a Parser in 5 Minutes

```bash
# 1. Capture command output
parism capture "htop -b -n 1"

# 2. Scaffold a parser pack
parism init-parser htop

# 3. Edit parser.ts and verify fixtures (fixture replay is planned; use parism inspect for manual comparison today)

# 4. Register -- available immediately, no restart needed
parism add ./htop

# 5. Verify -- raw/parsed/compact comparison + token counts
parism inspect "htop -b -n 1"
```

Registered parsers are stored in `~/.parism/parsers/` and automatically loaded when the MCP server starts.

### A closed loop for reproducing failures

`parism capture` → a human writes the expected values → `parism test` → the changed paths come back. This one path is the plan's section 8, "parser tests that reproduce failures".

```bash
parism capture "git status --porcelain"
# Fixture saved: ~/.parism/fixtures/git-20261005-122126.json
# Exit code: 0
# This fixture replays but has no expected values yet.

# ── a human fills in the expected block ──
#   "expected": {
#     "parsed": { "entries": [ … ] },
#     "evidence": { "pointers": { "/entries/0/path": [ { "source": "stdout", "line": 0, "start": 3, "end": 13 } ] } },
#     "reviewed_by": "your name",
#     "note": "why this value is right"
#   }

parism test ~/.parism/fixtures
# fixture 12
#   reviewed expectations 9 — matched 8, changed 1
#   unreviewed expectations 3 (a person must review before it becomes a contract)
#
# unintended contract changes: 2 — do not make a release call before checking these:
#   git-20261005-122126  (git)
#   [evidence] 2
#     /evidence/entries/0/path/0/line  value  expected 0 → actual 1
```

**What you need to know**

- **Capture does not store raw output.** Secrets, home paths, and `--token=`-style argument values are redacted, and *what* was redacted is kept in `redactions`. Sensitive values keep their shape and lose only the value — deleting them outright would make the fixture look fabricated. Argv keeps the option name and the length, because argv also feeds the comparison key (`--token=<redacted:12>`).
- ### `parism eval` — three separate judgments

`parism eval` actually runs commands on this host and checks whether they met expectations.
It does not report a single success rate, because three things with different causes are
being measured at once:

| Level | What it looks at |
|---|---|
| `execution` | Did the command **actually run?** A guard refusal is not an execution failure |
| `parse` | Was it read structurally · **no parser exists** · explicit parse failure |
| `task` | Did it do its job. **Finding something absent succeeds by failing** |

Two of these are deliberately *not* failures — counting them as such would report the policy
working as a parism failure. A guard refusal shows up as `execution: blocked` on its own.

- **No parser is not a failure.** It is the fact that parism does not know the format.
- **An unsupported format fails explicitly.** It does not return an empty result quietly; it suggests a usable substitute.
- **An item with no stated expectation is left out of the rates.** Unknown things are not reported as known.

The `retry-rate` scenario measures one contract directly: **a retained result is never re-executed.**
It retains a result from an empty temporary repository, then **creates a new file**. If the new
file shows up in the retained result, the command was re-run.

```bash
parism eval                    # all scenarios
parism eval execution-parse    # one scenario
parism eval --verbose          # every observation
```

Exit code is 1 if any item with an expectation does not match.

**Without `reviewed_by` an expectation is a proposal, not a contract.** `parism test` does not count it as a contract violation. It also never *writes* expectations — auto-updating them is the cheapest way to hide a regression.
- **Replay does not re-execute the command.** It uses the stored stdout only. Re-running would mix in the environment at that moment and make "the parser changed" indistinguishable from "the machine changed".
- **Evidence expectations check only the pointers you list.** Turn on `evidence.exhaustive: true` for a full sweep.
- The manifest contract is SPECIFICATION 5.2.4.

### CLI Commands

| Command | Description |
|---|---|
| `parism capture "<command>"` | Execute a command and save its **sanitized** output as a fixture manifest |
| `parism init-parser <name>` | Scaffold a TypeScript parser pack (parser.ts + schema.json + fixtures/) |
| `parism test [dir]` | Replay a fixture set offline and report **which paths changed** (exit 1 on a broken fixture) |
| `parism add <path>` | Register a local parser pack permanently to ~/.parism/parsers/ |
| `parism inspect <command> [args...]` | Compare raw / parsed / compact output + token counts |

### ParserPack Interface

External parsers implement this interface:

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* return structured result */ },
  schema: { /* JSON Schema */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
  acceptedFlags: { "-a": "bool", "-n": "value" }, // optional: flags whose output format is handled; others yield unsupported_format
  acceptedPositionals: { max: 1 },                // optional: positional argument rule
  supports: (args) => args.length < 4,            // optional: extra rule applied after the declaration
  headerLines: 1,                                 // optional: number of non-data header lines
  noise: /^Total /,                               // optional: pattern for non-data lines
  rowsKey: "items",                               // optional: array holding one row per data line (invariant checks)
};

export default pack;
```

### External Parser Isolation

Registered packs run, by default, in one worker thread per pack (`parsers.external_isolation: "worker"`). The server thread never executes the pack module; it receives only the declared contract, and function-valued declarations such as `supports` and `hint` are evaluated in the worker on each call. When a single `parse()` exceeds `external_time_limit_ms` (default 500 ms), the worker exits abnormally, or its heap exceeds `external_memory_limit_mb` (default 128 MB), the call reports `parse_error.reason = "parser_exception"` and the worker is restarted on the next call. The server keeps responding. With `strict_schemas`, the worker validates the result against the pack schema.

- `parse()` must return structured-clone-able data. Values containing functions, Promises or Symbols yield `parser_exception`.
- `parse()` cannot see server-thread global state. `console` output inside a pack goes to stderr.
- Each call copies the input and the result: about 0.1 ms extra per call for a 20-line input and about 1.6 ms for 500 lines (`npm run benchmark:external`).
- To run packs on the server thread as before, set `"parsers": { "external_isolation": "none" }` in the global `~/.parism/prism.config.json`.
- `parism add` also reads the pack name in a worker. The fixture replay helper (`runFixtureTests`) is an author tool and runs the pack on the calling thread.

Worker isolation is fault isolation, not a security sandbox. A worker has the same permissions as the server process (files, network, child processes, environment variables). Register only packs you wrote or reviewed, and run Parism inside a container or VM when you need third-party packs you do not trust. See [SECURITY.md](SECURITY.md).

Running `parism` without arguments starts the MCP server as before.

---

## What Parism Is Not

Parism is not a new shell. It does not replace bash. It sits above bash, receives output, and structures it.

Parism is not an operating system for AI. Its concern is singular: when an agent issues a command, return the result in a form the agent can understand.

Parism does **not** invent evidence. It can answer where a value came from as a byte span, but that is not proof the value is true. Completeness that was never confirmed is `unknown`, not `false`.

Parism does **not** re-run the same command to answer evidence, budget, or comparison questions. It reads a retained copy, continues a truncated result, or compares two stored results. It will not execute a command on your behalf to fill a gap.

Parism is **not** a watch loop. Comparison is between two results that already exist. When to look again is the caller's decision.

Parism does **not** promise an exact model token count. The fixed tokenizers (`parism/approx`, `byte`) hold for the parism JSON payload only — not transport, client, or model-internal tokens.

The Unix philosophy was "do one thing well." Parism understands that.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
