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

Text parsing breaks easily. `ps aux` has different column ordering on Linux and macOS. The `1K-blocks` header in `df -h` varies by environment. Filenames with spaces almost always break `ls` parsing. Parism's parsers handle these cases directly. The agent receives structured data.

### Fewer Retries

When an agent misinterprets output, it re-queries, runs a second command to verify, or proceeds with bad data. All three cost tokens. Structured output reduces room for misinterpretation. The file count is not something to infer — it is `entries.length`.

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

---

## Guard — Why Not to Trust the Agent

`rm -rf /` can be written in three characters.

Agents make mistakes. They lose context, confuse paths, generate unintended commands. Guard is not about distrust — it is about designing so that agent mistakes do not become catastrophes.

There are four layers of defense.

**Command Whitelist**: Commands not in `allowed_commands` are never executed. No process is created. Rejected silently.

**Path Restriction**: When `allowed_paths` is set, commands referencing paths outside it are blocked. The agent cannot touch `/etc`.

**Injection Pattern Blocking**: If `;`, `$(`, `` ` ``, `&&`, `||`, or `|` appear in any argument, the command is not executed. Regardless of agent intent.

**Per-Command Argument Restrictions** *(v0.1.2)*: Specific flags can be blocked per command. `node -e` and `node --eval` allow arbitrary code execution — they are blocked by default. `npx --yes` silently installs packages from the internet — also blocked.

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

## Supported Commands — 31 Built-in Parsers

| Category | Command | Parsed Output |
|---|---|---|
| Filesystem | `ls` | `entries[]` — name, type, permissions, size, modified time, owner |
| Filesystem | `find` | `paths[]` — list of paths |
| Filesystem | `stat` | `file`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, timestamps |
| Filesystem | `du` | `entries[]` — size, path |
| Filesystem | `df` | `filesystems[]` — partition, usage, mount point |
| Filesystem | `tree` | `root`, `tree{}` — hierarchical node map, `total_files`, `total_dirs` |
| Process | `ps` | `processes[]` — PID, CPU%, MEM%, command |
| Process | `kill` | raw pass-through |
| Network | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` |
| Network | `curl -I` | `status_code`, `headers{}` |
| Network | `netstat` | `connections[]` — proto, local/foreign address, state |
| Network | `lsof -i` | `entries[]` — PID, process name, protocol, local/remote address, state |
| Network | `ss` | `entries[]` — state, recv/send queue, local/peer address, process |
| Network | `dig` | `query`, `answers[]` — type, value, TTL, `query_time_ms` |
| Text | `grep` | `matches[]` — file, line number, text |
| Text | `wc` | `entries[]` — count, filename |
| Text | `head`, `tail`, `cat` | `lines[]` |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]` |
| Git | `git log --oneline` | `commits[]` — hash, message |
| Git | `git diff` | `files_changed[]` |
| Git | `git branch -vv` | `branches[]` — name, current, upstream, ahead/behind |
| Env | `env` | `vars{}` — key-value map (secrets filtered) |
| Env | `pwd` | `path` |
| Env | `which` | `paths[]` |
| System | `free` | `mem`, `swap` — total, used, free, available in bytes |
| System | `uname` | `kernel_name`, `hostname`, `kernel_release`, `machine`, `os` |
| System | `id` | `uid`, `gid`, `user`, `group`, `groups[]` — id, name |
| Windows | `dir` | `directory`, `entries[]` — name, type, size, modified time, `free_bytes` |
| Windows | `tasklist` | `processes[]` — name, PID, session, memory. CSV format supported |
| Windows | `ipconfig` | `hostname`, `adapters[]` — IPv4/6, subnet, gateway, DNS, MAC |
| Windows | `systeminfo` | `hostname`, `os_name`, memory, `hotfixes[]`, `network_cards[]` |

Commands without a parser return `parsed: null`. `raw` is always present.

---

## Installation

### npx

```bash
npx @nerdvana/parism
```

### Local Build

```bash
git clone https://github.com/your-org/parism
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

Once connected, a single `run` tool is exposed. The agent uses it to execute commands and receive JSON.

---

## Configuration

Place `prism.config.json` in the project root to control Guard behavior.

```json
{
  "guard": {
    "allowed_commands": ["ls", "git", "find", "grep", "env", "ps"],
    "allowed_paths": ["/home/user/projects"],
    "timeout_ms": 10000,
    "block_patterns": [";", "$(", "`", "&&", "||", "|"],
    "command_arg_restrictions": {
      "node": { "blocked_flags": ["-e", "--eval", "-r", "--require", "-p", "--print"] },
      "npx":  { "blocked_flags": ["--yes", "-y"] }
    },
    "env_secret_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "CREDENTIAL"]
  }
}
```

`allowed_paths` being empty means no path restriction. That decision is yours.

`env_secret_patterns` strips matching environment variables from child processes before execution. The `env` command will not expose them.

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
