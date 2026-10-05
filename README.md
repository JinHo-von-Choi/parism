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

## 60초 데모 — 아래 숫자는 이 문서에서 실제로 실행한 값이다

`experiments/demo-60s.mjs` 가 만드는 그대로다. `npm run build && node experiments/demo-60s.mjs` 로 재현된다(고정 시드). **약속이 아니라 측정값**이다.

**장면 1 — 200행 목록에 예산을 걸면 무엇이 빠졌는지 보인다**

```
목록 200행 중 138행 표시
예산 생략 68행
측정 19987 / 20000 토큰 (parism/approx, exact=false)
파싱 오류 0건
누락 내역: ["budget"]
  budget: 68 of 206 row(s) were left out to fit 20000 tokens
          total=206 returned=138 omitted=68
```

보이는 순서가 중요하다. **몇 개를 보여줬는지, 몇 개를 뺐는지, 왜 뺐는지, 파싱이 틀렸는지**가 각각 다른 필드로 분리된다. 숫자가 안 맞으면 조용히 줄어드는 대신 `budget_met: false` 가 된다.

**장면 2 — 고른 값의 원문 구간**

```
고른 값   "changed.ts" ( M)
원문 구간 byte[3, 13) = "changed.ts"
성격      verbatim
마스킹    가려지지 않음
```

`ls` 에는 필드 근거가 없다. 그래도 `source_kind: "none"` 으로 **"근거 없음"이라고 말한다** — 없는 근거를 지어내지 않는다. `ps` 와 `git status --porcelain` 은 바이트 구간을 준다.

**장면 3 — 나머지는 명령을 다시 실행하지 않고**

```
이어 읽기 1회 후 206행 확보 (중복 없음)
```

그리고 그 뒤로:

```
모르는 id:      unknown_id      ← 이 세션이 모르는 id
보관 안 함:     not_retained    ← 처음부터 보관하지 않음
```

두 사유가 다르다. 무엇을 해야 하는지가 다르기 때문이다. **둘 다 자동으로 재실행하지 않는다.**

**숫자 하나를 짚는다.** 같은 138행을 원문까지 받으면 19,987 토큰, 원문 없이 필수 필드만 받으면 1,995 토큰이다. 차이는 raw 원문이다. 그래서 예산을 걸면 무엇을 버릴지 **사전에** 정해야 한다. 2,000 토큰으로 이 목록을 부르면 실측 0행이 나온다 — 행이 아니라 원문만으로 상한을 넘기 때문이다. 그때도 조용히 넘기지 않고 이유를 밝힌다.

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

**경로 제한**: `allowed_paths`를 설정하면 `cwd`와 경로 인자를 검사한다. 위치 인자와 플래그 값 중 `/`를 포함하거나 `.`, `~`로 시작하거나 `cwd` 기준으로 존재하는 항목(심볼릭 링크 포함)을 가리키는 것은 모든 명령에서 검사하고, 경로를 받는 명령의 위치 인자(`cat subdir/file`, `find src`)와 경로 플래그 값은 항상 검사한다. 허용 경로 밖이면 차단된다. 커널 수준 샌드박스는 아니며, 가드 수준의 방어선이다.

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
| 파일시스템 | `ls -l` | `entries[]`: 이름, 타입, 권한, 크기, 수정 시각, 소유자, 링크 대상, `directory`(`-R`과 피연산자 둘 이상의 구획) | O |
| 파일시스템 | `find` | `paths[]`: 경로 목록 | O |
| 파일시스템 | `stat` | `file`, `link_target`, `size_bytes`, `inode`, `permissions`, `uid`, `gid`, 타임스탬프. 파일이 여럿이면 `files[]` | O |
| 파일시스템 | `du` | `entries[]`: 크기, 경로, `modified_at`(`--time`) | O |
| 파일시스템 | `df` | `filesystems[]`: 파티션, `type`(`-T`), 크기, 사용량, 마운트 위치. 1K 블록은 `blocks_1k`, 단위 붙은 크기(`-h`)는 `size`, 다른 블록 단위는 `size`와 `block_size` | O |
| 파일시스템 | `tree` | `root`, `tree{}`: 계층 구조 노드, `total_files`, `total_dirs` | O |
| 프로세스 | `ps aux` | `processes[]`: PID, CPU%, MEM%, 명령어, `depth`(트리 출력) | O |
| 프로세스 | `kill` | raw pass-through (기본 차단, prism.config.json에서 명시적 허용 시 사용) | X |
| 네트워크 | `ping` | `target`, `packets_transmitted`, `packet_loss_percent`, `rtt_*_ms` | O |
| 네트워크 | `curl -I` | `status_code`, `headers{}`, `header_values{}`(반복 헤더), `history[]`(`-L`의 앞선 응답) | O |
| 네트워크 | `netstat` | `connections[]`: proto, local/foreign address, state | O |
| 네트워크 | `lsof -i` | `entries[]`: PID, 프로세스명, 프로토콜, 로컬/원격 주소, 상태(`-u` 사용자 선택 포함) | O |
| 네트워크 | `ss` | `connections[]`: netid, 상태, 수신/발신 큐, 로컬/피어 주소와 포트 | O |
| 네트워크 | `dig` | `query`, `query_type`(QUESTION 섹션이 없으면 빈 문자열), `answers[]`: 타입, 값, TTL, `query_time_ms`. 쿼리가 여럿이면 `queries[]`에 응답마다 | O |
| 텍스트 | `grep -n` | `matches[]`: 파일, 라인 번호, 텍스트, `byte_offset`(`-b`), `context`(`-A/-B/-C`의 문맥 줄). 빈 줄 일치(`-v`, 빈 패턴)도 행이다. `-r`의 이름 열은 `-n`이나 `-b`와 함께 받는다 | O |
| 텍스트 | `wc` | `entries[]`: 개수 플래그 하나면 count, 파일명. 플래그가 없거나 여럿이면 `lines`, `words`, `chars`, `bytes`, `max_line_length` 가운데 고른 열과 파일명. 파일명은 공백까지 그대로. `--total=only`(개수 플래그 하나)는 `total` | O |
| 텍스트 | `head`, `tail`, `cat` | `lines[]` | O |
| Git | `git status` | `branch`, `staged[]`, `modified[]`, `untracked[]`, `renamed[]`, `ignored[]`, `unmerged[]`, `detached` | O |
| Git | `git log --oneline` | `commits[]`: hash, message, `refs[]`(`--decorate=full`의 전체 참조 이름), `author`, `date`(`--format=%h%x09%an%x09%aI%x09%s`) | O |
| Git | `git diff` | `files_changed[]`, `files[]`: path, status, old_path, binary, hunks | O |
| Git | `git branch -vv` | `branches[]`: 이름, current, upstream, ahead/behind(상류가 사라졌으면 `null`), `upstream_gone`, `detached`, `points_to` | O |
| DevOps | `kubectl get pods`, `kubectl get events` | `pods[]`/`events[]`: 상태, 재시도, 이벤트 사유/메시지 | O |
| DevOps | `docker ps`, `docker stats --no-stream` | `containers[]`: 이미지, 상태, 포트, 이름 / `stats[]`: CPU, 메모리, 네트워크, 블록 I/O, pids | O |
| DevOps | `gh pr list` | `pull_requests[]`: 번호, 제목, 상태, 작성자, 라벨 | O |
| DevOps | `helm list` | `releases[]`: name, namespace, status, chart, app_version | O |
| DevOps | `terraform plan` (build 프로필) | `summary`: to_add, to_change, to_destroy | O |
| 환경 | `env` | `vars{}`: 키-값 맵 | O |
| 환경 | `pwd` | `path` | O |
| 환경 | `which` | `paths[]` | O |
| 시스템 | `free` | `rows{}`: mem/swap별 total, used, free, available (기본 KB, `*_bytes`는 bytes) | O |
| 시스템 | `uname` | `kernel`, `hostname`, `release`, `version`, `arch`, `os` | O |
| 시스템 | `id` | `uid`, `gid`, `username`, `groups[]`: id, name | O |
| 시스템 | `systemctl list-units` | `units[]`: name, load, active, sub, description (Linux) | O |
| 시스템 | `journalctl` (short 계열 `-o`) | `entries[]`: timestamp, hostname(`--no-hostname`이면 빈 문자열), unit, pid, message (Linux) | O |
| 시스템 | `apt list`, `apt search` | `packages[]`: name, suite, version, arch, status, description(search) | O |
| 시스템 | `brew list --versions` | `packages[]`: name, version | O |
| 패키지 | `npm list`, `pnpm list` | `dependencies[]`: name, version, depth, `deduped`, `problem` | O |
| 패키지 | `yarn list` (build 프로필) | `dependencies[]`: name, version, depth | X |
| 패키지 | `cargo tree` (build 프로필) | `crates[]`: name, version, path, source, depth, deduped, proc_macro | O |
| Windows | `dir` | `directory`, `entries[]`: 이름, 타입, 크기, 수정 시각, `free_bytes` | X |
| Windows | `tasklist` | `processes[]`: 이름, PID, 세션, 메모리. CSV 형식 지원 | X |
| Windows | `ipconfig` | `hostname`, `adapters[]`: IPv4/6, 서브넷, 게이트웨이, DNS, MAC | X |
| Windows | `systeminfo` | `hostname`, `os_name`, 메모리, `hotfixes[]`, `network_cards[]` | X |

기본 허용(O)=DEFAULT_CONFIG에 포함. X=prism.config.json에서 명시적 허용 필요. (build 프로필) 표시는 `guard.profile: "build"`가 필요하다.

파서가 없는 명령어는 `parsed: null`로 반환된다. `raw`는 그대로 있다. 파서가 예외를 던지면 `stdout.parse_error`에 `{ reason: "parser_exception", message: string }`가 포함되어 "파서 없음"과 "파서 버그"를 구분할 수 있다.

> 실행이 실패했거나 stdout 없이 stderr만 있으면 `result.failure`는 실행 실패(`kind: "exec"`, stderr를 담은 메시지)를 유지하고 파싱 오류는 `stdout.parse_error`에만 남는다.
>
> `stdout.parse_error.reason` 은 `"parser_exception"`, `"schema_violation"`, `"unsupported_format"`, `"unrecognized_output"` 네 값을 가진다. `unsupported_format` 은 파서가 해당 인자의 출력 형식을 지원하지 않을 때, `unrecognized_output` 은 데이터 줄이 있는데 파서가 어떤 값도 인식하지 못했을 때 반환된다. "파서 없음"은 `parse_error`가 아니라 `result.failure.reason === "parser_not_found"` 로 노출된다(`result.failure.kind === "parse"`).

### 허용 형식과 대체 인자 안내

내장 파서는 출력 형식을 실측으로 확인한 인자 범위(허용 플래그, 위치 인자 규칙, 서브커맨드)를 계약으로 선언한다(`src/parsers/contracts.ts`). 범위 밖의 인자는 파서를 실행하지 않고 `unsupported_format`을 반환한다. 틀린 값을 조용히 돌려주는 대신 실패를 드러내기 위해서다. `raw`는 그대로이고, 출력이 JSON 문서이면 네이티브 JSON 패스스루가 `parsed`를 채운다.

같은 정보를 처리 가능한 형식으로 얻는 인자가 있으면 `result.failure.hint`(같은 값이 `stdout.parse_error.hint`)에 `{ args, reason }`으로 담긴다. `args`는 같은 명령에 그대로 넘기는 전체 인자이며 readonly 기본 정책을 통과한다.

| 요청 | `failure.hint.args` |
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

같은 정보를 얻는 인자가 없으면(`ls -li`, `ps -ef`, `grep -z` 등) `hint`가 없다.

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

MCP 서버 없이 Node.js 프로세스 내부에서 Parism 을 직접 호출할 수 있다. v1.0.0 부터 정식 API 다. Semantic Versioning 을 따른다.

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

RunOptions: `args` / `cwd` / `format` / `includeDiff` / `select` / `where` / `sort_by` / `limit` / `array`. RunPagedOptions: `args` / `cwd` / `format` / `includeDiff` + `page` / `page_size`. `engine.describe("git")`은 한 명령의 능력 요약을 돌려준다.

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
- `contract_version` — `"stable"`(기본) 또는 `"next"`. `"next"` 일 때만 `review` 가 붙는다(아래 '근거 조회').
- `evidence` — `"none"`(기본), `"rows"`, `"fields"`. 필드 근거 계산량. `contract_version: "next"` 와 함께 쓴다.
- `retain` — 결과를 세션 메모리에 보관해 `explain_result` 로 다시 본다. `contract_version: "next"` 와 함께 쓴다.
- `budget` — `{ max_tokens, tokenizer, required_fields, overflow }`. 응답을 예산 안에 넣고 무엇이 빠졌는지 밝힌다(아래 '토큰 예산').
- `select`, `where`, `sort_by`, `limit`, `array`: 서버 측 투영과 필터. 아래 참조.

**아래 네 인자(`contract_version`·`evidence`·`retain`·`budget`)는 모두 opt-in 이다.** 지정하지 않으면 응답에 새 필드가 붙지 않는다.

compact 예시:

```json
{
  "schema": ["name", "type", "size_bytes"],
  "rows": [["src", "directory", 4096], ["main.ts", "file", 1200]]
}
```

#### 투영과 필터

`select`(필드 목록), `where`(조건 목록), `sort_by`(`{ field, order }`), `limit`(행 수)은 파싱 결과의 최상위 배열(`ls`의 `entries`, `git log`의 `commits` 등)에만 적용한다. 적용 순서는 `where`, `sort_by`, `limit`, `select`다. 배열이 여럿이면 `array`로 고른다.

```json
{
  "cmd": "ls", "args": ["-l"],
  "where":   [{ "field": "type", "op": "eq", "value": "file" }, { "field": "size_bytes", "op": "gt", "value": 1000 }],
  "sort_by": { "field": "size_bytes", "order": "desc" },
  "limit":   10,
  "select":  ["name", "size_bytes"]
}
```

- 조건 연산: `eq`, `ne`(문자열, 수, 불리언, `null`), `prefix`, `contains`(문자열, 대소문자 구분), `gt`, `gte`, `lt`, `lte`(수). 조건은 모두 맞아야 한다.
- 결과에는 `_summary: { total, matched, shown }`이 붙고 `stdout.raw`는 실리지 않는다. 결과 객체 안의 배열이면 `parsed._summary`, 결과가 배열이면 `stdout._summary`다.
- 정렬은 안정 정렬이며 값이 없는 행은 뒤에 둔다. `format: "compact"`와 함께 쓸 수 있고 적응형 형식 임계값은 줄어든 행 수를 본다.
- 없는 필드나 형이 맞지 않는 비교는 `failure.kind = "config"`(`unknown_field`, `type_mismatch`)이며 raw를 남긴다. 문법이 틀린 인자는 실행하지 않는다.
- 500개 항목 디렉터리의 `ls -l`에서 `select: ["name","size_bytes"], limit: 50`은 응답 토큰을 96% 줄인다(28,609 → 1,066, 기본 설정, gpt-tokenizer).

### run_paged

대용량 출력을 페이지 단위로 읽는다. `ps aux`, `find`, `grep -r` 등에 사용한다.

파라미터:
- `cmd`, `args`, `cwd` — `run`과 동일
- `page` — 0-indexed 페이지 번호 (기본값: `0`)
- `page_size` — 페이지당 줄 수 (기본값: `default_page_size` 설정값, 기본 100)
- `page_size` 상한: `max_page_size`(기본 1000). 넘는 요청은 그 값으로 줄이고 `page_info.requested_page_size`에 요청값을 남긴다
- `includeDiff` — 파일시스템 diff 포함 여부 (기본값: `false`). `false`면 스냅샷 생략으로 지연 감소.

응답 추가 필드:
- `page_info.total_lines` — 전체 줄 수
- `page_info.has_next` — 다음 페이지 존재 여부
- `page_info.cache` - `{ hit, age_ms }`. 후속 페이지는 30초 안에서 첫 실행 결과를 재사용한다
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

파라미터:
- `cmd`: 선택. 주면 그 명령의 능력 요약만 반환한다(아래).

응답:
- `version` — Parism 패키지 버전
- `allowed_commands` — guard에서 허용하는 명령 목록
- `available_parsers` — 등록된 파서 이름 목록
- `guard_summary` — `timeout_ms`, `max_output_bytes`, `max_items`, `block_patterns`(전체 배열), `allowed_paths`
- `telemetry_enabled` — 텔레메트리 활성화 여부
- `stats`: 텔레메트리를 켰을 때만. 명령별 결과 횟수

에이전트가 Parism을 처음 사용할 때 이 도구를 먼저 호출하면 가용 명령과 제한 사항을 한눈에 파악할 수 있다.

`describe({ cmd: "git" })`는 한 명령의 정보를 2KB 이하로 돌려준다. 정책 거부나 형식 미지원으로 재시도하기 전에 확인하는 용도다.
- `policy`: guard가 허용하는 서브커맨드, 플래그, 위치 인자 규칙과 정책 출처(`origin`: `default`, `build`, `config`, `none`)
- `parser`: 파서가 처리하는 형식. `requires`(하나 이상 필요한 플래그), `values`(값 패턴), `flags`, `rows_key`, `row_fields`, 서브커맨드별 같은 모양
- `alternatives`: 형식 밖 인자를 대신할 인자(`{ from, args, reason }`)
- `examples`: 현재 guard를 통과하는 예시 인자
- 이름 목록은 공백으로 이은 문자열이다. 허용되지 않은 명령은 `failure`(`command_not_allowed`)를 담은 결과다.

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

### 근거 조회 — `run(contract_version: "next")` + `explain_result`

**"이 값이 원문 어디에서 나왔나"를 바이트 구간으로 답한다.** 새 명령을 실행하지 않는다.

`run` 에 세 인자를 추가했다. **모두 opt-in 이며 기본값은 꺼짐이다** — 지정하지 않으면 응답이 이전과 완전히 같다.

- `contract_version` — `"stable"`(기본) 또는 `"next"`. `"next"` 일 때만 `review` 가 붙는다.
- `evidence` — `"none"`(기본), `"rows"`, `"fields"`. `"none"` 이 아니면 `contract_version: "next"` 도 필요하다.
- `retain` — 결과를 세션 메모리에 보관해 `explain_result` 로 다시 본다. `retain: true` 도 `contract_version: "next"` 필요.

`review` 는 기존 봉투 필드의 뜻을 바꾸지 않고 옆에 붙는다.

| 필드 | 뜻 |
|---|---|
| `result_id` | `explain_result`·`compare_results`·`fetch_result` 에 넘기는 id |
| `parser_id` / `parser_version` / `schema_version` | 이 결과를 만든 파서와 스키마 |
| `content_hash` | 원문 해시. 같은 실행을 반복했는지 판별 |
| `source_complete` | 수집이 끝났는가 (3. `parse_complete` 는 파싱이 끝났는가, 4. `representation_lossless` 는 압축·변환이 값을 잃지 않았는가) |
| `privacy_transform` | `"none"` / `"masked"` / `"unknown"` |
| `retained` | `explain_result` 로 다시 볼 수 있는가 |
| `warnings` | 왜 불완전하거나 근거가 없는지 |

**완성도는 `true`/`false`/`unknown` 세 값이다.** 확인하지 못한 것을 거짓으로 말하지 않기 위해 `unknown` 을 쓴다. 수집 상한에 걸리면 `source_complete: false` 이고 `warnings` 에 그 사실이 적힌다 — 근거는 보존된 앞부분만 덮는다.

`explain_result(result_id, pointer)` 는 JSON Pointer(예: `"/processes/0/pid"`)로 값과 근거를 돌려준다.

```json
{
  "ok": true, "result_id": "r_...", "pointer": "/processes/0/pid",
  "value": 1,
  "source_kind": "derived", "source_spans": [{ "source": "stdout", "start": 90, "end": 91, "line": 2, "transform": "parseInt" }],
  "transform": "parseInt", "age_ms": 12
}
```

- 구간은 **마스킹된 정규 원문의 UTF-8 바이트 오프셋** `[start, end)` 다. 파서가 값을 변환했다면 `derived` 로 밝히고 그 변환을 함께 준다.
- **근거는 그 순간 명령이 무엇을 출력했는지에 대한 링크다. 값이 참이라는 증명이 아니다.**
- 모르는 포인터는 `unknown_pointer`, 만료·퇴출된 id 는 그 사실과 함께 실패한다. **자동으로 재실행하지 않는다.**

근거를 만드는 파서는 `ps` 와 `git status --porcelain` 이다. 다른 파서는 근거가 없음을 `warnings` 로 알린다 — 지어내지 않는다.

**근거와 예산을 요청하면 적응형 compact 를 끈다.** 둘 다 결과 구조를 바꿔 근거 포인터와 필수 필드 계산 대상을 지우기 때문이다. `format: "compact"` 를 명시하면 그대로 압축하고 이유를 `warnings` 에 적는다.

### 토큰 예산 — `run(budget)` + `fetch_result`

**큰 결과를 예산 안에 받으면서 무엇이 빠졌는지 알 수 있다.** 핵심은 "예산 때문에 사라진 정보"와 "파서 오류 때문에 사라진 정보"를 섞지 않는 것이다.

```json
{ "max_tokens": 2000, "required_fields": ["path"], "overflow": "page" }
```

- **예산은 실행시간이나 수집량을 줄이는 기능이 아니다.** 이미 얻은 결과를 어디까지 내보낼지 정한다.
- `required_fields` 는 어떤 행에서도 빠지지 않는다. 파서가 선언한 행 identity 도 남는다. **필수 필드가 없으면 조용히 일부만 내보내지 않고 명시적으로 실패한다** — 부분 성공은 조용한 손실이다.
- 예산이 최소 봉투(약 1,200 토큰)에 못 미치면 **실행 전에** `budget_too_small` 로 거절한다.

응답에 `budget` 보고와 `omission` 목록이 붙는다.

- `budget` — `requested`, `measured_tokens`, `tokenizer_id`, `tokenizer_version`, `budget_met`, `tokenizer_exact`, `tokenizer_scope`
- `omission[]` — `stage`(`capture`/`parse`/`projection`/`budget`/`privacy`)와 `reason`, `rows_total`/`rows_returned`/`rows_omitted`, `omitted_fields`, `next_cursor`

**고정 토크나이저**는 `parism/approx`(근사)와 `byte`(문자 단위 정확) 둘이다. 새 런타임 의존성이 없다. 미지원 토크나이저는 조용히 대체하지 않고 `tokenizer_unsupported` 로 거절한다 — 추정을 정확한 예산으로 포장하지 않는다. 이 약속은 parism JSON payload 에만 성립하며 **전송·클라이언트·모델 내부 토큰은 포함하지 않는다**(`tokenizer_scope` 에 밝힌다).

`fetch_result(result_id, cursor, budget)` 는 저장된 같은 결과의 다음 페이지를 **재실행 없이** 돌려준다. `continuation.cursor` 를 그대로 넘긴다. cursor 는 진행 규칙(스냅샷 identity·투영·정책·스키마)과 위치를 함께 묶으므로 **클라이언트가 임의 오프셋을 조립할 수 없다.** 다른 결과의 cursor 는 `cursor_mismatch`, 조작한 cursor 는 `cursor_invalid` 로 거절한다. 만료·퇴출된 id 는 재실행하지 않고 그 사실만 알린다.

```
1. run(cmd, { budget: { max_tokens: 2000, overflow: "page" }, retain: true })
2. budget.budget_met 확인, omission 으로 무엇이 빠졌는지 확인
3. continuation.cursor 가 있으면 fetch_result(result_id, cursor) 반복
4. 다 읽을 때까지 가거나, omission 이 남았다면 그 사실을 사용자에게 알린다
```

### 의미 diff — `compare_results`

**이미 존재하는 두 결과만 비교한다.** 새 명령을 실행하지 않고, 원격에 접속하지 않고, 감시 루프를 만들지 않는다.

파라미터: `base_id`, `current_id`(`run(retain=true)` 의 `review.result_id`), 선택으로 `keys`·`ignore_fields`·`strict`.

응답: `comparable`, `refusals`, `added`/`removed`/`changed`/`unchanged_count`, `ignored_fields`, `partial`, `key_conflicts`. 필드 변화에는 이전·현재 근거 포인터가 붙는다.

**거짓 삭제 0** — 어느 한쪽이라도 불완전하면(수집 잘림·파서 실패·표현 손실) 없는 행을 '삭제'로 단정하지 않고 `partial.withheld_reasons` 에 보류를 남긴다. identity 를 확정하지 못한 행이 있어도 '추가'나 '삭제'를 단정하지 않는다 — 못 찾았다고 새로 생긴 것이 아니다. 중복 identity 는 조용히 한 행을 버리지 않고 `duplicate_identity` 로 멈춘다.

- 행 identity 규칙: git 은 저장소 identity(실경로) + 정규 경로. kubernetes 는 context/namespace/kind + `metadata.uid` 이며 **uid 없는 표 출력으로는 같은 자원이라고 말하지 않는다.** **ps 는 PID 만을 identity 로 삼지 않고 비교를 보류한다**(PID 재사용).
- **지문은 세계 상태를 캡처한 인증서가 아니다.** 같은 지문이어도 그 사이 파일이 바뀌었을 수 있다.
- 비밀 유출 방지: **argv 는 해시로 식별하고 표시에는 마스킹한 값만** 쓴다. **환경 변수는 '이름'만 관찰 기록에 남기고 값은 담지 않는다.**

### MCP 도구 목록 요약

| 도구 | 새 명령 실행 | 언제 쓰나 |
|---|---|---|
| `run` | O | 기본. `contract_version`·`evidence`·`retain`·`budget` 옵션 포함 |
| `run_paged` | O | 출력이 클 때 페이지 단위 |
| `explain_result` | **X** | 값의 출처를 확인할 때 (보관본만) |
| `fetch_result` | **X** | 예산으로 잘린 결과를 이어 읽을 때 |
| `compare_results` | **X** | 전후 차이를 볼 때 (두 보관본만) |
| `describe` | X | 처음 쓸 때 환경 파악 |
| `dry_run` | X | 실행 전 가드 확인 |

**세 도구(`explain_result`·`fetch_result`·`compare_results`)는 어떤 경우에도 명령을 다시 실행하지 않는다.** 모르는 id·만료·퇴출이면 그것을 알리고 끝낸다. 저장은 세션 메모리 TTL/LRU 다(결과당 2MiB, 합계 32MiB, 16개, 60초). 디스크에 남지 않는다.

---

## 마이그레이션 — 2.0.2에서

2.x 는 **기존 봉투 필드의 의미를 바꾸지 않는다.** `contract_version` 의 기본값이 `"stable"` 이므로 인자를 추가하지 않은 기존 소비자는 응답이 이전과 완전히 같다. 새 기능을 쓰려면 **opt-in 인자를 명시해야 한다.**

**파일을 바꿔야 하는 경우(breaking)**

| 대상 | 이전 | 지금 | 되돌리는 법 |
|---|---|---|---|
| 외부 ParserPack 작성자 | `contract.noise`/`rowLine`/`acceptedValues` 가 메인 스레드의 `RegExp` | 워커가 계산한 서술자와 `facts`. 메인 스레드에서 `RegExp` 가 아니다 | 전역 설정에 `parsers.external_isolation: "none"` |
| `toCompact()` / `parism inspect` 호출자 | `unknown` 반환 | `CompactOutcome`(`{ok:true,value}` \| `{ok:false,reason,message}`) | — (되돌리는 게 아니다. `representation_not_lossless` 를 처리해야 한다) |
| `guard.secrets.output_patterns` 를 생략한 설정 | 기본값이 `[]` 라서 기본 패턴 7개를 안 씀 | 기본값 없음. 생략하면 기본 패턴을 쓴다 | 설정에 `output_patterns: []` 을 명시 |
| `git status --porcelain` 을 쓰는 소비자 | `failure.hint` 의 '대안 형식 안내' 대상 | 지원 형식. `entries` 행 배열 | — |
| porcelain 항목을 통째로 직렬화해 저장한 코드 | 항목에 `xy`/`index`/`worktree`/`path`/`orig_path` | 같은 필드에 `quoted` 추가(줄 모드에서만 채워짐). **경로 값의 뜻은 두 모드에서 같다** | — |

**`output_patterns` 기본값 변경은 보안 관련이다.** 이전에는 사용자가 아무것도 쓰지 않아도(키를 생략해도) 기본 패턴이 **비활성**이 되어, 리댁션을 켠 상태에서 합성 비밀 5종(sk-, ghp_, AKIA, xoxb-, glpat-)이 전량 그대로 반환됐다. 생략하면 기본 패턴을 쓰고 `[]` 를 명시하면 비활성으로 구별된다.

**마이그레이션할 필요 없는 것**

- MCP 클라이언트 설정 — 도구 이름이 안 바뀌었다. 세 도구가 추가됐을 뿐이다.
- 기존 `run` 호출 — 새 인자를 주지 않으면 응답이 이전과 같다.
- 내부 파서 44종의 응답 — `git status --porcelain` 을 제외하고 그대로다.

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

`allowed_paths`가 비어 있으면 경로 제한 없이 실행된다. 판단은 당신 몫이다.

`guard.secrets.env_patterns`에 일치하는 환경 변수는 실행 전 자식 프로세스에서 제거된다. `env` 명령 실행 시 해당 변수가 노출되지 않는다.

`guard.secrets.output_redaction_enabled`는 기본 `false` 로 opt-in 방식이다. `true` 로 설정하면 `output_patterns` 에 매칭되는 문자열을 명령 실행 후 raw 출력에서 `[REDACTED]` 로 대체한다. 파싱 전에 적용되므로 `stdout.parsed` 결과에는 영향을 주지 않는다.

`command_arg_restrictions`는 기본값과 병합된다. 일부 명령만 override해도 나머지 기본 제한은 유지된다.

`parsers.strict_schemas`를 `true` 로 설정하면 각 파서의 Zod 스키마로 파싱 결과를 검증한다. 스키마 위반 시 `failure.reason === "schema_violation"` 을 반환한다. 기본 `false` 이며 opt-in 방식이다.

`parsers.external_isolation`, `external_time_limit_ms`, `external_memory_limit_mb`는 외부 파서 팩의 실행 방식과 상한이다(아래 "외부 파서 격리 실행"). 전역 설정에서 정하며, 신뢰하지 않는 프로젝트 설정은 격리를 끄거나 상한을 올리지 못한다.

`telemetry.enabled`를 `true`로 설정하면 응답 봉투에 `telemetry` 필드가 추가된다. guard/exec/parse/redact 각 단계의 소요 시간(ms)과 raw 출력 바이트 수를 포함한다. 기본 `false`이며 opt-in 방식이다. 켜면 프로세스 안에 명령별 결과 횟수(`parsed`, `unsupported_format`, `unrecognized_output`, `parser_exception`, `schema_violation`, `parser_not_found`, 사유별 `guard`, `exec`)도 모아 `describe`의 `stats`로 보여 준다. 외부로 보내거나 저장하지 않는다.

> legacy `env_secret_patterns` 는 v2.0.0 에서 제거됐다. 설정에 남아 있으면 stderr 에 경고하고 무시한다.

`guard.profile` 은 기본 `"readonly"` 이며 조회 서브커맨드만 허용한다. `"build"` 로 바꾸면 `npm run`, `npm test`, `cargo build`, `terraform plan`, `docker compose ps` 등 빌드·시험 서브커맨드가 추가로 허용된다. 프로젝트 코드를 실행하므로 신뢰하는 저장소에서만 켠다. `cargo` 조회 서브커맨드(`tree`, `metadata`, `search`, `pkgid`)는 저장소가 지정한 rustc 래퍼를 실행할 수 있으므로 `build` 프로필에서만 허용된다. `node`, `npx`, `yarn` 은 `allowed_commands` 에 직접 추가해야 하며 `build` 프로필에서만 동작한다. `npx` 에는 `--no` 를 붙여 설치된 실행 파일만 실행한다. 명령별 세부 규칙은 `guard.command_policies` 로 덮어쓴다. 프로젝트 `prism.config.json` 은 가드를 넓히지 못하며, 넓히려면 전역 `~/.parism/prism.config.json` 에 `"trust_project_config": true` 를 둔다.

저장소의 `prism.config.json` 은 설정 예시이며 npm 패키지에는 포함되지 않는다.

### 설정 레이어와 환경 변수

설정은 세 레이어를 순서대로 병합한다. 뒤 레이어가 앞 레이어를 덮어쓴다.

1. 전역: `~/.parism/prism.config.json`
2. 프로젝트: `<cwd>/prism.config.json`
3. 환경 변수: `PARISM_` 접두 변수

MCP 서버와 라이브러리 모드(`createEngine()`) 모두 동일한 3레이어 병합을 사용한다. `createEngine({ configPath })`로 특정 파일을 직접 지정하면 그 파일만 로드한다.

| 환경 변수 | 대상 설정 | 형식 |
|---|---|---|
| `PARISM_ALLOWED_COMMANDS` | `guard.allowed_commands` | 쉼표 구분 목록 |
| `PARISM_ALLOWED_PATHS` | `guard.allowed_paths` | 쉼표 구분 목록 |
| `PARISM_TIMEOUT_MS` | `guard.timeout_ms` | 정수 |
| `PARISM_MAX_OUTPUT_BYTES` | `guard.max_output_bytes` | 정수 |
| `PARISM_MAX_ITEMS` | `guard.max_items` | 정수 |
| `PARISM_DEFAULT_PAGE_SIZE` | `guard.default_page_size` | 정수 |
| `PARISM_STRICT_SCHEMAS` | `parsers.strict_schemas` | `true` 또는 `1` |
| `PARISM_ADAPTIVE_FORMAT_JSON` | `parsers.adaptive_format_threshold.json` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_COMPACT` | `parsers.adaptive_format_threshold.compact` | 정수 |
| `PARISM_ADAPTIVE_FORMAT_JSON_NO_RAW` | `parsers.adaptive_format_threshold.json_no_raw` | 정수 |
| `PARISM_TELEMETRY_ENABLED` | `telemetry.enabled` | `true` 또는 `1` |

---

## 커스텀 파서 -- 직접 만들고 바로 쓴다

44개 내장 파서로 부족하면, 직접 만들면 된다. Parism v0.5.0 부터 CLI 도구가 포함된다. v1.0.0 부터 `ParserPack.schema` 는 Zod 스키마를 단일 소스로 사용한다.

### 5분 안에 파서 만들기

```bash
# 1. 명령어 출력을 캡처한다
parism capture "htop -b -n 1"

# 2. 파서 팩 스캐폴드를 생성한다
parism init-parser htop

# 3. parser.ts를 편집하고 fixture를 검증한다 (fixture replay 는 예정 기능, 현재는 parism inspect 로 수동 대조)

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
| `parism test [parser]` | fixture replay 테스트 실행 (예정, 미구현) |
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
  acceptedFlags: { "-a": "bool", "-n": "value" }, // 선택: 출력 형식을 검증한 플래그. 그 밖은 unsupported_format
  acceptedPositionals: { max: 1 },                // 선택: 위치 인자 규칙
  supports: (args) => args.length < 4,            // 선택: 선언 뒤에 추가로 적용하는 규칙
  headerLines: 1,                                 // 선택: 데이터가 아닌 머리 줄 수
  noise: /^Total /,                               // 선택: 데이터가 아닌 줄 패턴
  rowsKey: "items",                               // 선택: 데이터 줄마다 행 하나를 담는 배열(불변식 검사용)
};

export default pack;
```

### 외부 파서 격리 실행

등록한 팩은 기본적으로 팩마다 하나의 워커 스레드에서 읽고 실행한다(`parsers.external_isolation: "worker"`). 서버 스레드는 팩 모듈을 실행하지 않고 계약 선언만 받으며, `supports`와 `hint` 같은 함수 선언은 호출할 때마다 워커에서 평가한다. `parse()` 호출 하나(`supports`, `hint` 왕복 포함)가 `external_time_limit_ms`(기본 500ms)를 넘기거나, 워커가 비정상 종료하거나, V8 힙이 `external_memory_limit_mb`(기본 128MB)를 넘으면 `parse_error.reason = "parser_exception"`으로 보고한다. 그 뒤 대기 시간(2초에서 시작해 장애가 이어지면 두 배씩, 최대 30초) 동안은 워커를 띄우지 않고 바로 실패로 답하고, 대기 시간이 지난 뒤의 호출이 워커를 다시 띄운다. 서버는 계속 응답한다. `strict_schemas` 검사는 워커가 팩 스키마로 수행한다.

- `parse()`의 반환값은 구조화 복제가 가능한 값이어야 한다. 함수, Promise, Symbol이 든 값은 `parser_exception`이다.
- `parse()`는 서버 스레드의 전역 상태를 볼 수 없다. 팩 안의 `console`과 `process.stdout.write` 출력은 stderr로 간다.
- 힙 상한은 V8 힙만 제한한다. `Buffer`처럼 힙 밖에 잡는 메모리는 제한하지 않는다.
- 호출마다 입력과 결과를 복제하는 비용이 든다. 20줄 입력에서 호출당 약 0.1ms, 500줄 입력에서 약 1.6ms가 더해진다(`npm run benchmark:external`).
- 이전처럼 서버 스레드에서 실행하려면 전역 `~/.parism/prism.config.json`에 `"parsers": { "external_isolation": "none" }`을 둔다.
- `parism add`도 팩 이름을 워커에서 읽는다. 팩 이름은 영문자나 숫자로 시작하고 영문자, 숫자, `.`, `_`, `-`로 된 1~64자여야 한다. fixture replay 도우미(`runFixtureTests`)는 작성자 도구라 같은 스레드에서 실행한다.

워커 격리는 결함 격리이지 보안 샌드박스가 아니다. 워커는 서버 프로세스의 권한(파일, 네트워크, 자식 프로세스, 환경 변수)을 그대로 가진다. 직접 작성했거나 검토한 팩만 등록하고, 신뢰할 수 없는 제3자 팩은 Parism 전체를 컨테이너나 VM 안에서 실행한다. [SECURITY.md](SECURITY.md) 참조.

인자 없이 `parism`을 실행하면 기존과 동일하게 MCP 서버로 동작한다.

---

## Parism이 아닌 것

Parism은 새로운 셸이 아니다. bash를 대체하지 않는다. bash 위에 앉아서 출력을 받아 구조화할 뿐이다.

Parism은 AI를 위한 운영체제가 아니다. 관심사는 하나다. 에이전트가 명령을 내렸을 때, 에이전트가 이해할 수 있는 형태로 결과를 돌려주는 것.

Parism은 **근거를 만들어내지 않는다.** 이 값이 원문 어디에서 나왔는지는 바이트 구간으로 답할 수 있지만, 그 값이 참이라는 증명은 아니다. 확인하지 못한 완성도는 `false` 가 아니라 `unknown` 이다.

Parism은 **근거 조회·예산·비교를 해도 같은 명령을 다시 실행하지 않는다.** 저장본을 보거나, 잘린 결과를 이어 읽거나, 전후를 비교하는 것까지다. 사라진 결과를 대신 실행해 주는 도구는 아니다.

Parism은 **감시 루프가 아니다.** 비교는 이미 있는 두 결과를 놓고 이루어진다. 언제 다시 확인할지는 호출자가 정한다.

Parism은 **정확한 모델 토큰 수를 약속하지 않는다.** 고정 토크나이저(`parism/approx`·`byte`)의 약속은 parism JSON payload 에만 성립한다. 전송·클라이언트·모델 내부 토큰은 포함하지 않는다.

Unix 철학은 "하나의 일을 잘 하라"였다. Parism은 그것을 이해한다.

---

<p align="center">
  Made by <a href="mailto:jinho.von.choi@nerdvana.kr">Jinho Choi</a> &nbsp;|&nbsp;
  <a href="https://buymeacoffee.com/jinho.von.choi">Buy me a coffee</a>
</p>
