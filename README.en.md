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

**Path Restriction**: When `allowed_paths` is set, Guard validates `cwd` and path args. Args starting with `/`, `./`, `../` and positional args of path-taking commands (`cat`, `find`, `ls`, `grep` — e.g. `cat subdir/file`, `find src`) are checked. References outside allowed paths are blocked. This is a guard, not a kernel-level sandbox.

**Injection Pattern Blocking**: If `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, or `<` appear in any argument, the command is not executed.

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
| Filesystem | `ls` | `entries[]` — name, type, permissions, size, modified time, owner | O |
| Filesystem | `find` | `paths[]` — list of paths | O |
| Filesystem | `stat` | `file`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, timestamps | O |
| Filesystem | `du` | `entries[]` — size, path | O |
| Filesystem | `df` | `filesystems[]` — partition, usage, mount point | O |
| Filesystem | `tree` | `root`, `tree{}` — hierarchical node map, `total_files`, `total_dirs` | O |
| Process | `ps` | `processes[]` — PID, CPU%, MEM%, command | O |
| Process | `kill` | raw pass-through (blocked by default, add to prism.config.json to allow) | X |
| Network | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` | O |
| Network | `curl -I` | `status_code`, `headers{}` | O |
| Network | `netstat` | `connections[]` — proto, local/foreign address, state | O |
| Network | `lsof -i` | `entries[]` — PID, process name, protocol, local/remote address, state | X |
| Network | `ss` | `connections[]` — state, recv/send queue, local/peer address | X |
| Network | `dig` | `query`, `answers[]` — type, value, TTL, `query_time_ms` | X |
| Text | `grep -n` | `matches[]` — file, line number, text | O |
| Text | `wc` | `entries[]` — count, filename | O |
| Text | `head`, `tail`, `cat` | `lines[]` | O |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]` | O |
| Git | `git log --oneline` | `commits[]` — hash, message | O |
| Git | `git diff` | `files_changed[]` | O |
| Git | `git branch -vv` | `branches[]` — name, current, upstream, ahead/behind | O |
| DevOps | `kubectl get pods`, `kubectl get events` | `pods[]` / `events[]` — status, restarts, reasons, messages | O |
| DevOps | `docker ps`, `docker stats --no-stream` | `containers[]` / `stats[]` — image, status, CPU/MEM/IO | O |
| DevOps | `gh pr list` | `pull_requests[]` — number, title, state, author, labels | O |
| DevOps | `helm list` | `releases[]` — name, namespace, status, chart, app_version | O |
| DevOps | `terraform plan` | `summary` — to_add, to_change, to_destroy | O |
| Env | `env` | `vars{}` — key-value map (secrets filtered) | O |
| Env | `pwd` | `path` | O |
| Env | `which` | `paths[]` | O |
| System | `free` | `mem`, `swap` — total, used, free, available in bytes | X |
| System | `uname` | `kernel_name`, `hostname`, `kernel_release`, `machine`, `os` | O |
| System | `id` | `uid`, `gid`, `user`, `group`, `groups[]` — id, name | X |
| System | `systemctl list-units` | `units[]` — name, load, active, sub, description (Linux) | O |
| System | `journalctl -o short-iso` | `entries[]` — timestamp, hostname, unit, pid, message (Linux) | O |
| System | `apt list --installed` | `packages[]` — name, version, arch, status | O |
| System | `brew list --versions` | `packages[]` — name, version | O |
| Package | `npm list`, `pnpm list`, `yarn list` | `dependencies[]` — name, version, depth | O |
| Package | `cargo tree` | `crates[]` — name, version, path | O |
| Windows | `dir` | `directory`, `entries[]` — name, type, size, modified time, `free_bytes` | X |
| Windows | `tasklist` | `processes[]` — name, PID, session, memory. CSV format supported | X |
| Windows | `ipconfig` | `hostname`, `adapters[]` — IPv4/6, subnet, gateway, DNS, MAC | X |
| Windows | `systeminfo` | `hostname`, `os_name`, memory, `hotfixes[]`, `network_cards[]` | X |

Default (O)=in DEFAULT_CONFIG. X=requires explicit allow in prism.config.json.

Commands without a parser return `parsed: null`. `raw` is always present. When a parser throws, `stdout.parse_error` contains `{ reason: "parser_exception", message: string }` so you can distinguish "no parser" from "parser bug".

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

Once connected, two tools are exposed: `run` and `run_paged`.

`run` is the default command runner with structured parsing when available.
`run_paged` returns paginated stdout for large output and includes `page_info`.

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

### run_paged

Use for large stdout (`ps aux`, `find`, `grep -r`).

Parameters:
- `cmd`, `args`, `cwd` — same as `run`
- `page` — 0-indexed page number (default: `0`)
- `page_size` — lines per page (default: `default_page_size`, 100 by default)
- `includeDiff` — include filesystem diff (default: `false`)

Extra fields:
- `page_info.total_lines` — total line count
- `page_info.has_next` — whether next page exists
- `stdout.parsed` — always `null` (partial output cannot be safely parsed)

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
    "env_secret_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"]
  }
}
```

`allowed_paths` being empty means no path restriction. That decision is yours.

`env_secret_patterns` strips matching environment variables from child processes before execution. The `env` command will not expose them.

`command_arg_restrictions` is deep-merged with defaults. Overriding one command does not remove restrictions for others.

---

## Custom Parsers -- Build and Use Immediately

When 44 built-in parsers are not enough, build your own. Parism v0.5.0 includes a CLI toolkit.

### Create a Parser in 5 Minutes

```bash
# 1. Capture command output
parism capture "htop -b -n 1"

# 2. Scaffold a parser pack
parism init-parser htop

# 3. Edit parser.ts and test against fixtures
parism test htop

# 4. Register -- available immediately, no restart needed
parism add ./htop

# 5. Verify -- raw/parsed/compact comparison + token counts
parism inspect "htop -b -n 1"
```

Registered parsers are stored in `~/.parism/parsers/` and automatically loaded when the MCP server starts.

### CLI Commands

| Command | Description |
|---|---|
| `parism capture "<command>"` | Execute command and save raw output as fixture |
| `parism init-parser <name>` | Scaffold a TypeScript parser pack (parser.ts + schema.json + fixtures/) |
| `parism test [parser]` | Run fixture replay tests |
| `parism add <path>` | Register a local parser pack permanently to ~/.parism/parsers/ |
| `parism inspect "<command>"` | Compare raw / parsed / compact output + token counts |

### ParserPack Interface

External parsers implement this interface:

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* return structured result */ },
  schema: { /* JSON Schema */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
};

export default pack;
```

Running `parism` without arguments starts the MCP server as before.

---

## What Parism Is Not

Parism is not a new shell. It does not replace bash. It sits above bash, receives output, and structures it.

Parism is not an operating system for AI. Its concern is singular: when an agent issues a command, return the result in a form the agent can understand.

The Unix philosophy was "do one thing well." Parism understands that.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
