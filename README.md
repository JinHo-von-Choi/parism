# Parism

> Refract the Shell. Every command, structured.
>
> AI 에이전트를 위한 안전하고 예측 가능한 OS 실행 게이트웨이.

<p align="right"><a href="README.md">한국어</a> | <a href="README.en.md">English</a></p>

> 문서: [README](README.md) · [SPECIFICATION](SPECIFICATION.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

설계 결정, 버전 이력, 모듈 구조의 단일 권위 문서: [SPECIFICATION.md](SPECIFICATION.md)

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

## 솔직한 이야기 — 토큰은 더 든다

Parism을 만들 때 기대한 것은 토큰 절약이었다. 구조화된 데이터가 raw 텍스트보다 효율적일 것이라고.

17개 시나리오를 벤치마크한 결과는 그 기대를 정면으로 배반했다. JSON 출력은 raw 텍스트보다 평균 205% 더 무겁다. `ls -la` 200개 파일 기준으로 raw 5,807 토큰, Parism 15,531 토큰. 거의 세 배다. 키 이름이 매 항목마다 반복되기 때문이다. 인간의 눈에 테이블 헤더 한 줄이면 되는 정보를 N번 써야 한다.

하지만 같은 벤치마크가 다른 사실 하나를 드러냈다. 에이전트가 raw 텍스트를 직접 파싱할 때 오독률이 평균 4.18%, 공백이 섞인 파일명에서는 28.6%에 달했다. 열 번 중 세 번은 틀린다. 틀린 결과로 에이전트가 다음 작업을 수행하고, 그 작업이 또 틀리고, 결국 사람이 개입해서 되돌린다. 재시도 토큰, 디버깅 시간, 롤백 비용. 보이지 않는 곳에서 비용이 불어난다.

그러나 같은 벤치마크가 한 가지 더 보여준 것이 있다. "AI한테 설명하는 토큰"의 소멸이다. raw 텍스트를 주면 에이전트에게 "이 출력은 이런 형식이고, 첫 번째 열이 권한이고, 세 번째가 소유자야"라고 알려줘야 한다. 그 컨텍스트 프롬프트가 Parism을 쓰면 평균 61% 줄어든다. JSON이 스스로 자기 구조를 설명하기 때문이다. 에이전트는 키를 읽으면 된다.

그리고 역전이 일어나는 지점이 있다. 단발성 조회 — `ls` 한 번 치고 끝나는 작업 — 에서는 Parism이 토큰을 더 먹는다. 그러나 그 결과를 에이전트가 다음 작업에 사용하는 순간, 비용 구조가 뒤집힌다. raw를 잘못 읽은 에이전트가 존재하지 않는 경로에 파일을 쓰고, 그 오류를 디버깅하느라 히스토리를 뒤지고, 재시도하고, 또 틀리는 순환이 시작되면 토큰은 눈덩이가 된다. 구조화된 데이터로 시작한 에이전트는 그 순환에 진입하지 않는다.

Parism의 경제성은 청구서 위에 있지 않다. 한 번 더 읽는 비용보다, 한 번 잘못 읽어서 치르는 비용이 압도적으로 크다.

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

macOS의 `stat`은 더 극적이다. Linux와 출력 형식이 완전히 다르다. Linux는 `Size: 4096`처럼 레이블이 붙지만, macOS는 레이블 없는 단일 줄이다. Linux 파싱 패턴을 적용하면 정확도는 0%다. Parism은 OS를 감지하고 적합한 파서를 선택한다. 에이전트는 그 차이를 알 필요가 없다.

Parism의 CFR은 0%다. 파서는 deterministic code이기 때문이다. 정규표현식 추론이 아니라 구조적 분해다. 에이전트는 구조화된 데이터만 받는다.

### 재시도가 줄어든다

에이전트가 출력을 잘못 해석하면 재질문하거나, 다른 명령으로 다시 확인하거나, 잘못된 정보를 바탕으로 다음 단계를 진행한다. 세 가지 모두 토큰이 든다. 구조화된 출력은 오해의 여지를 줄인다. 파일이 몇 개인지 묻지 않아도 `entries.length`다.

### 에이전트가 다른 일을 더 잘하게 된다

텍스트를 파싱하는 것은 추론이다. 추론에는 인지 자원이 소모된다. 에이전트가 출력 형식을 해독하는 데 자원을 쓰면, 실제 작업 — 코드를 분석하고, 설계를 판단하고, 다음 단계를 결정하는 일 — 에 쓸 자원이 줄어든다. 구조화된 데이터를 받으면 파싱이라는 작업 자체가 사라진다. 에이전트는 읽기만 하면 되고, 남은 역량을 본래의 작업에 집중할 수 있다.

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

### diff는 선택적이다

`includeDiff: true`일 때만 `diff`에 `created`, `deleted`, `modified`가 채워진다. run/run_paged 기본값은 `includeDiff: false`이므로 스냅샷 비용을 생략하여 MCP 호출 지연을 줄인다.

---

## 가드 — 에이전트를 신뢰하지 않는 이유

`rm -rf /`는 세 개의 문자로 쓸 수 있다.

에이전트는 오류를 범한다. 문맥을 잃고, 경로를 착각하고, 의도하지 않은 명령을 생성한다. Guard는 에이전트를 불신하는 것이 아니다. 에이전트의 실수가 파국으로 이어지지 않도록 설계하는 것이다.

네 겹의 방어선이 있다.

**화이트리스트**: `allowed_commands`에 없는 명령어는 실행되지 않는다. 프로세스를 만들지도 않는다. 설명 없이 거절한다.

**경로 제한**: `allowed_paths`를 설정하면 `cwd`와 경로 인자를 검사한다. `/`, `./`, `../`로 시작하는 인자와, `cat`, `find`, `ls`, `grep`, `git`, `docker`, `kubectl`, `cargo` 등 경로를 받는 명령의 positional 인자(`cat subdir/file`, `find src`)도 허용 경로 밖이면 차단된다. 커널 수준 샌드박스는 아니며, 가드 수준의 방어선이다.

**인젝션 패턴 차단**: 각 인자를 개별적으로 순회하며 `;`, `$(`, `` ` ``, `&&`, `||`, `|`, `>`, `>>`, `<`가 포함되면 실행하지 않는다. 인자 단위 검사이므로 서로 다른 인자 경계를 넘어서는 오탐이 발생하지 않는다.

**명령별 인자 제한**: 명령마다 차단할 플래그를 지정할 수 있다. `node -e`, `node --eval`, `node --input-type`은 기본 차단된다. `npx --yes`도 기본 차단된다.

차단된 명령은 이런 응답을 반환한다.

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

> v0.6 부터 `failure` 필드가 권위 필드다. `guard_error` 는 하위 호환을 위해 유지된다. 에이전트는 `result.failure.kind` 로 분기하는 것을 권장한다.

에이전트는 실행 결과와 동일한 구조로 차단 이유를 받는다. 예외가 터지지 않는다. 파이프라인이 깨지지 않는다.

Guard의 위협 모델, 4겹 방어선의 한계, 신뢰할 수 없는 환경에서의 격리 권고는 [SECURITY.md](SECURITY.md)를 참조한다.

---

## 지원 명령어 — 44종 내장 파서

| 카테고리 | 명령어 | 파싱 결과 | 기본 허용 |
|---|---|---|---|
| 파일시스템 | `ls` | `entries[]` — 이름, 타입, 권한, 크기, 수정 시각, 소유자 | O |
| 파일시스템 | `find` | `paths[]` — 경로 목록 | O |
| 파일시스템 | `stat` | `file`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, 타임스탬프 | O |
| 파일시스템 | `du` | `entries[]` — 크기, 경로 | O |
| 파일시스템 | `df` | `filesystems[]` — 파티션, 사용량, 마운트 위치 | O |
| 파일시스템 | `tree` | `root`, `tree{}` — 계층 구조 노드, `total_files`, `total_dirs` | O |
| 프로세스 | `ps` | `processes[]` — PID, CPU%, MEM%, 명령어 | O |
| 프로세스 | `kill` | raw pass-through (기본 차단, prism.config.json에서 명시적 허용 시 사용) | X |
| 네트워크 | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` | O |
| 네트워크 | `curl -I` | `status_code`, `headers{}` | O |
| 네트워크 | `netstat` | `connections[]` — proto, local/foreign address, state | O |
| 네트워크 | `lsof -i` | `entries[]` — PID, 프로세스명, 프로토콜, 로컬/원격 주소, 상태 | X |
| 네트워크 | `ss` | `entries[]` — 상태, 수신/발신 큐, 로컬/피어 주소, 프로세스 | X |
| 네트워크 | `dig` | `query`, `answers[]` — 타입, 값, TTL, `query_time_ms` | X |
| 텍스트 | `grep -n` | `matches[]` — 파일, 라인 번호, 텍스트 | O |
| 텍스트 | `wc` | `entries[]` — count, 파일명 | O |
| 텍스트 | `head`, `tail`, `cat` | `lines[]` | O |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]` | O |
| Git | `git log --oneline` | `commits[]` — hash, message | O |
| Git | `git diff` | `files_changed[]` | O |
| Git | `git branch -vv` | `branches[]` — 이름, current, upstream, ahead/behind | O |
| DevOps | `kubectl get pods`, `kubectl get events` | `pods[]`/`events[]` — 상태, 재시도, 이벤트 사유/메시지 | O |
| DevOps | `docker ps`, `docker stats --no-stream` | `containers[]`/`stats[]` — 이미지, 상태, CPU/MEM/IO | O |
| DevOps | `gh pr list` | `pull_requests[]` — 번호, 제목, 상태, 작성자, 라벨 | O |
| DevOps | `helm list` | `releases[]` — name, namespace, status, chart, app_version | O |
| DevOps | `terraform plan` | `summary` — to_add, to_change, to_destroy | O |
| 환경 | `env` | `vars{}` — 키-값 맵 | O |
| 환경 | `pwd` | `path` | O |
| 환경 | `which` | `paths[]` | O |
| 시스템 | `free` | `rows{}` — mem/swap별 total, used, free, available (bytes) | X |
| 시스템 | `uname` | `kernel`, `hostname`, `release`, `version`, `arch`, `os` | O |
| 시스템 | `id` | `uid`, `gid`, `username`, `groups[]` — id, name | X |
| 시스템 | `systemctl list-units` | `units[]` — name, load, active, sub, description (Linux) | O |
| 시스템 | `journalctl -o short-iso` | `entries[]` — timestamp, hostname, unit, pid, message (Linux) | O |
| 시스템 | `apt list --installed` | `packages[]` — name, version, arch, status | O |
| 시스템 | `brew list --versions` | `packages[]` — name, version | O |
| 패키지 | `npm list`, `pnpm list`, `yarn list` | `dependencies[]` — name, version, depth | O |
| 패키지 | `cargo tree` | `crates[]` — name, version, path | O |
| Windows | `dir` | `directory`, `entries[]` — 이름, 타입, 크기, 수정 시각, `free_bytes` | X |
| Windows | `tasklist` | `processes[]` — 이름, PID, 세션, 메모리. CSV 형식 지원 | X |
| Windows | `ipconfig` | `hostname`, `adapters[]` — IPv4/6, 서브넷, 게이트웨이, DNS, MAC | X |
| Windows | `systeminfo` | `hostname`, `os_name`, 메모리, `hotfixes[]`, `network_cards[]` | X |

기본 허용(O)=DEFAULT_CONFIG에 포함. X=prism.config.json에서 명시적 허용 필요.

파서가 없는 명령어는 `parsed: null`로 반환된다. `raw`는 그대로 있다. 파서가 예외를 던지면 `stdout.parse_error`에 `{ reason: "parser_exception", message: string }`가 포함되어 "파서 없음"과 "파서 버그"를 구분할 수 있다.

> v0.6 부터 `parse_error.reason` 은 `"parser_exception"`, `"parser_not_found"`, `"schema_violation"` 세 값을 가질 수 있다. 같은 정보가 `result.failure.kind === "parse"` 로도 노출된다.

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

## 라이브러리 모드

MCP 서버 없이 Node.js 프로세스 내부에서 Parism 을 직접 호출할 수 있다. v1.0.0 부터 정식 API 다. Semantic Versioning 을 따르며, breaking change 는 v2.0.0 에서만 발생한다.

최소 예시:

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine();
const result = await engine.run("ls", { args: ["-la"] });
console.log(result.stdout.parsed);
```

`createEngine()`은 `prism.config.json`을 로드하고 외부 파서를 등록한 뒤 `ParismEngine` 인스턴스를 반환한다. 커스텀 설정 경로가 필요하면 `createEngine({ configPath: "/path/to/prism.config.json" })`을 사용한다.

설정 경로 지정과 `failure` 분기를 함께 쓰는 실용 예시:

```typescript
import { createEngine } from "@nerdvana/parism/engine";

const engine = await createEngine({
  configPath: "/path/to/custom/prism.config.json",
});

const result = await engine.run("git", { args: ["status", "--porcelain"] });

if (!result.ok) {
  console.error(`[${result.failure?.kind}] ${result.failure?.reason}: ${result.failure?.message}`);
  process.exit(1);
}

console.log(result.stdout.parsed);
```

RunOptions — `args` / `cwd` / `format` / `includeDiff`. RunPagedOptions — 위 옵션 전체 + `page` / `page_size`.

설계 상세는 [SPECIFICATION.md](SPECIFICATION.md) §1.1 참조.

---

## MCP 클라이언트 설정

Parism 은 MCP stdio 프로토콜을 통해 주요 AI CLI/IDE 에 연결할 수 있다. 클라이언트별 상세 설정은 `docs/mcp-clients/` 디렉토리를 참조한다.

| 클라이언트 | 가이드 |
|---|---|
| Claude Desktop | [docs/mcp-clients/claude-desktop.md](docs/mcp-clients/claude-desktop.md) |
| Claude Code | [docs/mcp-clients/claude-code.md](docs/mcp-clients/claude-code.md) |
| Cursor | [docs/mcp-clients/cursor.md](docs/mcp-clients/cursor.md) |
| Gemini CLI | [docs/mcp-clients/gemini-cli.md](docs/mcp-clients/gemini-cli.md) |
| Codex CLI | [docs/mcp-clients/codex.md](docs/mcp-clients/codex.md) |
| GitHub Copilot CLI | [docs/mcp-clients/copilot-cli.md](docs/mcp-clients/copilot-cli.md) |

연결이 성공하면 `run`, `run_paged`, `describe`, `dry_run` 네 도구가 노출된다. 에이전트는 먼저 `describe`로 허용 명령과 파서를 파악하고, `dry_run`으로 guard 통과 여부를 사전 확인한 뒤, `run` / `run_paged`로 명령을 실행하고 구조화된 JSON 응답을 받는다.

---

## Tools

### run

모든 명령의 기본 도구. 출력이 작거나 구조화 파싱이 필요할 때 사용한다.

파라미터:
- `cmd` — 명령어 이름 (예: `ls`, `git`)
- `args` — 인자 배열 (기본값: `[]`)
- `cwd` — 작업 디렉토리 (기본값: 현재 디렉토리)
- `format` — 출력 형식 (`"json"` 기본값, `"compact"`, `"json-no-raw"`). compact는 리스트형 출력을 schema+rows 컬럼 기반으로 압축하여 토큰 비용을 절감한다.
- `includeDiff` — 파일시스템 diff 포함 여부 (기본값: `false`). `false`면 스냅샷 생략으로 지연 감소. MCP 고빈도 호출 시 권장.

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
- `includeDiff` — 파일시스템 diff 포함 여부 (기본값: `false`). `false`면 스냅샷 생략으로 지연 감소.

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

### describe

에이전트 온보딩 도구. 현재 환경의 허용 명령, 사용 가능 파서, guard 제한, 버전 정보를 반환한다.

파라미터: 없음.

응답:
- `version` — Parism 패키지 버전
- `allowed_commands` — guard에서 허용하는 명령 목록
- `available_parsers` — 등록된 파서 이름 목록
- `guard_summary` — `timeout_ms`, `max_output_bytes`, `max_items`, `block_patterns_count`, `allowed_paths`
- `telemetry_enabled` — 텔레메트리 활성화 여부

에이전트가 Parism을 처음 사용할 때 이 도구를 먼저 호출하면 가용 명령과 제한 사항을 한눈에 파악할 수 있다.

### dry_run

guard 사전 검증 도구. 명령을 실행하지 않고 guard 통과 여부만 확인한다.

파라미터:
- `cmd` — 명령어 이름 (예: `rm`, `git`)
- `args` — 인자 배열 (기본값: `[]`)
- `cwd` — 작업 디렉토리 (기본값: 현재 디렉토리)

응답:
- `would_pass` — guard 통과 여부
- `reason` — 차단 시 사유 (`command_not_allowed`, `path_not_allowed`, `injection_pattern`, `arg_not_allowed`)
- `message` — 차단 시 상세 메시지

예: `dry_run("rm", ["-rf", "/"])` → `{ would_pass: false, reason: "command_not_allowed", message: "..." }`

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
    "secrets": {
      "env_patterns": ["TOKEN", "SECRET", "AUTHZ", "PASSWORD", "PASSWD", "CREDENTIAL"],
      "output_patterns": ["Bearer [A-Za-z0-9._\\-]+", "ghp_[A-Za-z0-9]+"],
      "output_redaction_enabled": false
    }
  },
  "parsers": {
    "strict_schemas": false
  },
  "telemetry": {
    "enabled": false
  }
}
```

`allowed_paths`가 비어 있으면 경로 제한 없이 실행된다. 판단은 당신 몫이다.

`guard.secrets.env_patterns`에 일치하는 환경 변수는 실행 전 자식 프로세스에서 제거된다. `env` 명령 실행 시 해당 변수가 노출되지 않는다.

`guard.secrets.output_redaction_enabled`는 기본 `false` 로 opt-in 방식이다. `true` 로 설정하면 `output_patterns` 에 매칭되는 문자열을 명령 실행 후 raw 출력에서 `[REDACTED]` 로 대체한다. 파싱 전에 적용되므로 `stdout.parsed` 결과에는 영향을 주지 않는다.

`command_arg_restrictions`는 기본값과 병합된다. 일부 명령만 override해도 나머지 기본 제한은 유지된다.

`parsers.strict_schemas`를 `true` 로 설정하면 각 파서의 Zod 스키마로 파싱 결과를 검증한다. 스키마 위반 시 `failure.reason === "schema_violation"` 을 반환한다. 기본 `false` 이며 opt-in 방식이다.

`telemetry.enabled`를 `true`로 설정하면 응답 봉투에 `telemetry` 필드가 추가된다. guard/exec/parse/redact 각 단계의 소요 시간(ms)과 raw 출력 바이트 수를 포함한다. 기본 `false`이며 opt-in 방식이다.

> legacy `env_secret_patterns` 는 v2.0.0 에서 제거된다. 사용 시 stderr 에 deprecation 경고가 출력된다.

---

## 커스텀 파서 -- 직접 만들고 바로 쓴다

44개 내장 파서로 부족하면, 직접 만들면 된다. Parism v0.5.0 부터 CLI 도구가 포함된다. v1.0.0 부터 `ParserPack.schema` 는 Zod 스키마를 단일 소스로 사용한다.

### 5분 안에 파서 만들기

```bash
# 1. 명령어 출력을 캡처한다
parism capture "htop -b -n 1"

# 2. 파서 팩 스캐폴드를 생성한다
parism init-parser htop

# 3. parser.ts를 편집하고 fixture를 테스트한다
parism test htop

# 4. 등록한다 -- 재시작 없이 즉시 사용 가능
parism add ./htop

# 5. 결과를 확인한다 -- raw/parsed/compact 비교 + 토큰 수
parism inspect "htop -b -n 1"
```

등록된 파서는 `~/.parism/parsers/`에 저장되고, MCP 서버 시작 시 자동으로 로드된다.

### CLI 명령어

| 명령어 | 설명 |
|---|---|
| `parism capture "<command>"` | 명령어를 실행하고 raw 출력을 fixture로 저장 |
| `parism init-parser <name>` | TypeScript 파서 팩 스캐폴드 생성 (parser.ts + schema.json + fixtures/) |
| `parism test [parser]` | fixture replay 테스트 실행 |
| `parism add <path>` | 로컬 파서 팩을 ~/.parism/parsers/에 영구 등록 |
| `parism inspect "<command>"` | raw / parsed / compact 출력 비교 + 토큰 수 |

### ParserPack 인터페이스

외부 파서는 이 인터페이스를 구현한다.

```typescript
import type { ParserPack } from "@nerdvana/parism/types";

const pack: ParserPack = {
  name: "my-command",
  parse(raw, args, ctx?) { /* 구조화된 결과 반환 */ },
  schema: { /* JSON Schema */ },
  fixtures: [{ input: "...", args: [], expected: { /* ... */ } }],
};

export default pack;
```

인자 없이 `parism`을 실행하면 기존과 동일하게 MCP 서버로 동작한다.

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
