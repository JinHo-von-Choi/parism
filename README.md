# Parism

> Refract the Shell. Every command, structured.
>
> AI 에이전트를 위한 안전하고 예측 가능한 OS 실행 게이트웨이.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

---

## 셸은 당신을 위해 설계되지 않았다

1969년 Ken Thompson이 Unix를 만들 때, 그는 출력 대상이 사람이라고 가정했다. 정확히 말하면 터미널 앞에 앉아 있는, 눈이 달린 생물.

반세기가 지났다. 이제 터미널을 읽는 것은 사람만이 아니다.

AI 에이전트는 `ls -la`를 실행하고, 그 출력을 받는다. 그리고 거기서 진짜 작업이 시작된다. 공백을 기준으로 분리하고, 첫 번째 열이 권한이고, 세 번째가 소유자이고, 파일명이 어디서 시작하는지를 토큰을 태워가며 추론한다. 인간의 눈이 0.1초에 처리하는 것을.

이것은 번역이 아니다. 암호화된 적도 없는 메시지를 해독하는 일이다.

---

## 왜 문제인가

세 번의 번역이 일어난다.

첫 번째: 커널이 파일시스템 메타데이터를 `stat` 구조체로 관리한다. `inode`, `mode`, `uid`, `gid`, `size`, `mtime`. 이미 완벽하게 구조화된 데이터다.

두 번째: `ls`가 그 구조를 인간이 읽기 좋은 텍스트로 평탄화한다. `drwxr-xr-x  2 user group 4096 Mar 06 09:23 src`. 구조가 텍스트로 무너진다.

세 번째: 에이전트가 그 텍스트를 다시 구조로 되돌리려 한다. 무너진 것을 다시 세우는 작업이다.

Parism이 개입하는 것은 두 번째와 세 번째 사이다. 한 번 버려진 구조를 되찾는 것이다.

이것이 비용이다. `ls` 한 번 실행하고 파일 목록을 얻는 것처럼 보이지만, 실제로는 에이전트가 출력을 파싱하는 데 수십 번의 추론 단계를 거친다. 그리고 종종 틀린다. 경계 케이스, 예상치 못한 공백, OS별로 미묘하게 다른 출력 형식. 틀리면 재시도한다. 재시도는 다시 토큰이다.

---

## Parism이 하는 일

프리즘은 빛을 파괴하지 않는다. 분해할 뿐이다.

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

정보는 달라지지 않는다. 형태가 달라진다. 에이전트는 이제 파싱하지 않는다. 읽기만 한다.

---

## 어떻게 좋은가

### 파싱 오류가 없어진다

텍스트 파싱은 깨지기 쉽다. `ps aux`는 리눅스와 macOS에서 컬럼 순서가 다르다. `df -h`의 `1K-blocks` 헤더는 환경에 따라 다르게 나온다. 파일명에 공백이 있으면 `ls` 파싱은 거의 반드시 틀린다.

수치로 말하면: raw 텍스트를 에이전트가 직접 파싱할 때 평균 CFR(Critical Failure Rate)은 4.18%다. 공백이 포함된 파일명이 섞이면 28.6%까지 치솟는다. 1000회 호출 시 286회는 잘못된 파일 목록을 기반으로 에이전트가 다음 작업을 수행한다는 뜻이다. 잘못된 파일을 읽고, 존재하지 않는 경로에 쓰고, 엉뚱한 파일을 삭제한다.

Parism의 CFR은 0%다. 파서는 deterministic code이기 때문이다. 정규표현식 추론이 아니라 구조적 분해다. 에이전트는 구조화된 데이터만 받는다.

### 재시도가 줄어든다

에이전트가 출력을 잘못 해석하면 재질문하거나, 다른 명령으로 다시 확인하거나, 잘못된 정보를 바탕으로 다음 단계를 진행한다. 세 가지 모두 토큰이 든다. 구조화된 출력은 오해의 여지를 줄인다. 파일이 몇 개인지 묻지 않아도 `entries.length`다.

### raw가 항상 보존된다

파서가 틀릴 수도 있다. 파서가 없는 명령어일 수도 있다. 그래서 Parism은 `raw`를 항상 유지한다. `parsed`는 보너스다. `raw`는 보험이다. 에이전트는 항상 원본으로 돌아갈 수 있다.

```json
"stdout": {
  "raw": "drwxr-xr-x ...",
  "parsed": { "entries": [ ... ] }
}
```

### 응답 구조가 일정하다

성공이든 실패든, `ok`와 `exitCode`는 항상 같은 자리에 있다. 에이전트가 분기 처리를 작성하는 방식이 단순해진다. "stdout을 파싱해서 오류인지 확인"이 아니라 `if (!result.ok)`다.

### 실행 시간이 기록된다

모든 응답에 `duration_ms`가 포함된다. 명령이 느린지 빠른지를 에이전트가 판단하는 데 쓸 수 있다. 디버깅할 때도 유용하다.

---

## 가드 — 에이전트를 신뢰하지 않는 이유

`rm -rf /`는 세 개의 문자로 쓸 수 있다.

에이전트는 오류를 범한다. 문맥을 잃고, 경로를 착각하고, 의도하지 않은 명령을 생성한다. Guard는 에이전트를 불신하는 것이 아니다. 에이전트의 실수가 파국으로 이어지지 않도록 설계하는 것이다.

네 겹의 방어선이 있다.

**화이트리스트**: `allowed_commands`에 없는 명령어는 실행되지 않는다. 프로세스를 만들지도 않는다. 설명 없이 거절한다.

**경로 제한**: `allowed_paths`를 설정하면 `cwd`뿐 아니라 경로형 인자(`/`, `./`, `../` 시작)도 검사한다. 허용 경로 밖을 참조하면 차단된다.

**인젝션 패턴 차단**: `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, `<`가 인자에 포함되면 실행하지 않는다.

**명령별 인자 제한**: 명령마다 차단할 플래그를 지정할 수 있다. `node -e`, `node --eval`, `node --input-type`은 기본 차단된다. `npx --yes`도 기본 차단된다.

차단된 명령은 이런 응답을 반환한다.

```json
{
  "ok": false,
  "guard_error": {
    "reason": "command_not_allowed",
    "message": "Command 'rm' is not in the allowed list"
  }
}
```

에이전트는 실행 결과와 동일한 구조로 차단 이유를 받는다. 예외가 터지지 않는다. 파이프라인이 깨지지 않는다.

---

## 지원 명령어 — 34종 내장 파서

| 카테고리 | 명령어 | 파싱 결과 |
|---|---|---|
| 파일시스템 | `ls` | `entries[]` — 이름, 타입, 권한, 크기, 수정 시각, 소유자 |
| 파일시스템 | `find` | `paths[]` — 경로 목록 |
| 파일시스템 | `stat` | `file`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, 타임스탬프 |
| 파일시스템 | `du` | `entries[]` — 크기, 경로 |
| 파일시스템 | `df` | `filesystems[]` — 파티션, 사용량, 마운트 위치 |
| 파일시스템 | `tree` | `root`, `tree{}` — 계층 구조 노드, `total_files`, `total_dirs` |
| 프로세스 | `ps` | `processes[]` — PID, CPU%, MEM%, 명령어 |
| 프로세스 | `kill` | raw pass-through |
| 네트워크 | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` |
| 네트워크 | `curl -I` | `status_code`, `headers{}` |
| 네트워크 | `netstat` | `connections[]` — proto, local/foreign address, state |
| 네트워크 | `lsof -i` | `entries[]` — PID, 프로세스명, 프로토콜, 로컬/원격 주소, 상태 |
| 네트워크 | `ss` | `entries[]` — 상태, 수신/발신 큐, 로컬/피어 주소, 프로세스 |
| 네트워크 | `dig` | `query`, `answers[]` — 타입, 값, TTL, `query_time_ms` |
| 텍스트 | `grep -n` | `matches[]` — 파일, 라인 번호, 텍스트 |
| 텍스트 | `wc` | `entries[]` — count, 파일명 |
| 텍스트 | `head`, `tail`, `cat` | `lines[]` |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]` |
| Git | `git log --oneline` | `commits[]` — hash, message |
| Git | `git diff` | `files_changed[]` |
| Git | `git branch -vv` | `branches[]` — 이름, current, upstream, ahead/behind |
| DevOps | `kubectl get pods`, `kubectl get events` | `pods[]`/`events[]` — 상태, 재시도, 이벤트 사유/메시지 |
| DevOps | `docker ps`, `docker stats --no-stream` | `containers[]`/`stats[]` — 이미지, 상태, CPU/MEM/IO |
| DevOps | `gh pr list` | `pull_requests[]` — 번호, 제목, 상태, 작성자, 라벨 |
| 환경 | `env` | `vars{}` — 키-값 맵 |
| 환경 | `pwd` | `path` |
| 환경 | `which` | `paths[]` |
| 시스템 | `free` | `rows{}` — mem/swap별 total, used, free, available (bytes) |
| 시스템 | `uname` | `kernel`, `hostname`, `release`, `version`, `arch`, `os` |
| 시스템 | `id` | `uid`, `gid`, `username`, `groups[]` — id, name |
| Windows | `dir` | `directory`, `entries[]` — 이름, 타입, 크기, 수정 시각, `free_bytes` |
| Windows | `tasklist` | `processes[]` — 이름, PID, 세션, 메모리. CSV 형식 지원 |
| Windows | `ipconfig` | `hostname`, `adapters[]` — IPv4/6, 서브넷, 게이트웨이, DNS, MAC |
| Windows | `systeminfo` | `hostname`, `os_name`, 메모리, `hotfixes[]`, `network_cards[]` |

파서가 없는 명령어는 `parsed: null`로 반환된다. `raw`는 그대로 있다.

### 네이티브 JSON 패스스루

파서가 없는 명령이라도 출력 자체가 JSON이면(예: `kubectl get pods -o json`, `docker inspect`) Parism이 이를 자동으로 감지하여 `parsed`에 넣는다. Guard 검사와 봉투 래핑은 동일하게 적용된다. 별도 설정은 필요 없다.

---

## 설치

### npx

```bash
npx @nerdvana/parism
```

### 로컬 빌드

```bash
git clone https://github.com/JinHo-von-Choi/parism
cd parism
npm install && npm run build
node dist/index.js
```

---

## Claude Desktop 연동

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

연결이 되면 `run`과 `run_paged` 두 도구가 노출된다. 에이전트는 이 도구로 명령을 실행하고 JSON을 받는다.

---

## Cursor 연동

전역 설정: `~/.cursor/mcp.json`

프로젝트별 설정: 프로젝트 루트 `.cursor/mcp.json` (이 프로젝트를 열었을 때만 parism 사용)

```json
{
  "mcpServers": {
    "parism": {
      "command": "node",
      "args": ["/home/nirna/job/nerdvana-prism/dist/index.js"],
      "cwd": "/home/nirna/job/nerdvana-prism"
    }
  }
}
```

빌드 후 위 설정을 `~/.cursor/mcp.json`의 `mcpServers`에 병합하거나, `.cursor/mcp.json`을 프로젝트 루트에 생성한다. Cursor 재시작 후 parism 도구가 사용 가능해진다.

---

## Tools

### run

모든 명령의 기본 도구. 출력이 작거나 구조화 파싱이 필요할 때 사용한다.

파라미터:
- `cmd` — 명령어 이름 (예: `ls`, `git`)
- `args` — 인자 배열 (기본값: `[]`)
- `cwd` — 작업 디렉토리 (기본값: 현재 디렉토리)
- `format` — 출력 형식 (`"json"` 기본값, `"compact"` 가능). compact는 리스트형 출력을 schema+rows 컬럼 기반으로 압축하여 토큰 비용을 절감한다.

compact 예시:

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

### run_paged

대용량 출력을 페이지 단위로 읽는다. `ps aux`, `find`, `grep -r` 등에 사용한다.

파라미터:
- `cmd`, `args`, `cwd` — `run`과 동일
- `page` — 0-indexed 페이지 번호 (기본값: `0`)
- `page_size` — 페이지당 줄 수 (기본값: `default_page_size` 설정값, 기본 100)

응답 추가 필드:
- `page_info.total_lines` — 전체 줄 수
- `page_info.has_next` — 다음 페이지 존재 여부
- `stdout.parsed` — 항상 `null` (부분 출력은 구조화 불가)

에이전트 패턴:

```
1. run_paged(cmd, page=0) → page_info.total_lines 확인
2. 범위가 작으면 그대로 사용
3. 범위가 크면 grep으로 먼저 필터링 후 run 호출
4. 필요한 페이지만 run_paged(page=N) 추가 호출
```

---

## 설정

`prism.config.json`을 프로젝트 루트에 두면 Guard 동작을 제어할 수 있다.

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
    "env_secret_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"]
  }
}
```

`allowed_paths`가 비어 있으면 경로 제한 없이 실행된다. 판단은 당신 몫이다.

`env_secret_patterns`에 일치하는 환경 변수는 실행 전 자식 프로세스에서 제거된다. `env` 명령 실행 시 해당 변수가 노출되지 않는다.

`command_arg_restrictions`는 기본값과 병합된다. 일부 명령만 override해도 나머지 기본 제한은 유지된다.

---

## Parism이 아닌 것

Parism은 새로운 셸이 아니다. bash를 대체하지 않는다. bash 위에 앉아서 출력을 받아 구조화할 뿐이다.

Parism은 AI를 위한 운영체제가 아니다. 관심사는 하나다. 에이전트가 명령을 내렸을 때, 에이전트가 이해할 수 있는 형태로 결과를 돌려주는 것.

Unix 철학은 "하나의 일을 잘 하라"였다. Parism은 그것을 이해한다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
