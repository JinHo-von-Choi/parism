# parism 실험 하네스 — A·B

작성자: 최진호
작성일: 2026-10-05

계획서 10장 "사용자 가치 실험" 의 두 실험을 **기계적으로 채점 가능한 부분**까지 구현했다.

```
npm run build
node experiments/experiment-a.mjs
node experiments/experiment-b.mjs
```

두 스크립트 모두 여기서 실행해 통과했다. **실측값이며 가설이 아니다.**

---

## 이 하네스가 재는 것과 재지 않는 것

**재는 것(기계 채점 가능)**

| | 측정 대상 |
|---|---|
| A | 정답 recall(기대값을 아는 fixture), 근거 존재·정확성, 예산 준수, 누락 내역 분리, 거절 사유 |
| B | 새로 생긴/해결된 이상 탐지, 필드 근거 부착, 순서·절단 상황에서의 거짓 변화 0, 보류 계약 |

**재지 않는 것(사람이 매겨야 한다)**

- 사람이 "이상"이라고 판단하는가
- 근거 확인에 실제로 걸린 시간
- 같은 정확성에서 토큰이 줄었는지, 그리고 줄어든 만큼 납득이 오르는지
- 경쟁 도구(jc 등) 대비 체감

**이 하네스가 숫자를 만들지 않는 것들을 숫자처럼 말하면 그것은 측정값이 아니라 추측이다.**

---

## 실행 환경: `dist` 를 써야 하는 이유

```
npm run build && node experiments/experiment-a.mjs
```

소스를 tsx 로 직접 실행하면 **이 호스트에서 `spawn(detached=true)` 가 ENOENT** 를 내 모든 명령이 `spawn_failed` 가 된다.

- 실측: 같은 인자로 `dist` 는 `find` 20건 정상 / tsx 소스 경로는 `spawn find ENOENT`
- 제품 결함이 아니다. 실험이 제품에 대한 측정치가 되려면 **제품과 같은 산출물**을 재야 한다.

---

## 부록 A. 실험 A — 큰 목록에서 조건에 맞는 대상 3개 + 근거

fixture: 파일 200개(`.ts`·`.js`·`.md`·`.json` 혼재), 그중 2KB 이상 `.ts` 가 37건. 고정 시드로 재현된다.

### 팔 ①: raw + 기존 Parism (근거·예산 없음)

```
경로 37건, raw 584 바이트
```

### 팔 ②: 새 budget (1,400토큰)

```
경로 37건, measured=898/1400
```

### 팔 ③: budget + 이어 읽기

```
1차 37건 + 이어 읽기 0회 = 37건
```

### 채점 결과(19항목 전부 통과)

```
PASS  기존 Parism 가 조건을 만족하는 전부를 낸다 — 37/37
PASS  큰 순 3건이 모두 들어 있다 — 3/3
PASS  이어 읽기까지 하면 전부 복원된다 — 37/37
PASS  조건을 안 맞는 값을 지어내지 않는다
PASS  최종 payload 가 예산 안이다 — 898 <= 1400
PASS  토크나이저가 고정된 것임을 밝힌다 — parism/approx
PASS  토큰 수가 근사치임을 숨기지 않는다 — exact=false
PASS  1차가 전부 담겼으면 누락 내역도 없다 — 0건
PASS  porcelain 전 항목에 원문 근거가 있다
PASS  근거 구간이 원문에서 그 값을 가리킨다 — 불일치 0건
PASS  잘못된 포인터를 조용히 빈 값으로 두지 않는다 — unknown_pointer
PASS  모르는 id 는 unknown_id 로 거절한다 — unknown_id
PASS  보관하지 않은 결과는 not_retained 로 거절한다
PASS  보관하지 않은 결과는 재실행 없이 거절한다 — not_retained
PASS  예산이 최소 봉투에 못 미치면 실행 전에 거절 — config/budget_too_small
PASS  미지원 토크나이저를 조용히 대체하지 않는다 — tokenizer_unsupported
PASS  허용 밖 경로를 조용히 처리하지 않는다 — path_not_allowed
```

### 무엇이 측정되지 않았나

- **토큰 절감률.** 1,400 예산에 37건이 다 들어와(898 토큰) 축약이 발생하지 않았다. 축약场景를 보려면 fixture 를 키우거나 예산을 더 낮춰야 한다. **37건에서 절감률을 말하면 그것은 측정값이 아니다.**
- 5~8명 실험의 과제 30개 · 5회 반복은 아직 돌리지 않았다. 이 스크립트는 그 실험의 **기계 채점 부분**이다.

---

## 부록 B. 실험 B — 전후에서 새로 생긴 이상 1건 + 해결된 1건 + 근거

### 영역 1: `git status --porcelain` — 비교가 **성립해야 하는** 경우

fixture:
```
=== 전(before) ===
 M b.txt   ?? c.txt
=== 후(after) ===
M  b.txt   A  c.txt
```

| | 전후 |
|---|---|
| 새로 생긴 이상 | `c.txt`: 미추적(`??`) → 스테이징(`A `) |
| 해결된 이상 | `b.txt`: 미스테이징(` M`) → 스테이징(`M `) |

### 팔 ①: 두 JSON 을 그대로 나란히

```
전 109 문자 / 후 109 문자
단순 JSON 비교로 어긋난 줄: 1줄
```

같은 37자 수인데 **한 줄이 어긋난 것으로 보인다.** 배열 순서와 인덱스가 얽혀 사람이 어디가 바뀌었는지 알 수 없다.

### 팔 ②: `compare_results`

```
comparable=true domain=git
added=0 removed=0 changed=2 unchanged=0
changed=[
  { label: ".../b.txt", status: "changed",
    changes: [ {field:"xy", before:" M", after:"M "},
               {field:"index", before:" ", after:"M"},
               {field:"worktree", before:"M", after:" "} ],
    base_pointer:"/0", current_pointer:"/0" },
  { label: ".../c.txt", status: "changed",
    changes: [ {field:"xy", before:"??", after:"A "}, ... ],
    base_pointer:"/1", current_pointer:"/1" } ]
```

`changed=2` 이고 **어느 행이 왜 바뀌었는지 + 원문 어느 위치인지**가 함께 나온다. `key` 같은 저장소 접두사가 아니라 `label` 로 읽을 수 있다.

### 영역 2: `kubectl get pods` — 비교를 **보류해야 하는** 경우

fixture:
```
=== 전 ===              === 후 ===
api-1  Running   0  5d   api-1  Running          0  5d
api-2  Running   0  5d   api-2  CrashLoopBackOff 7  5d
web-1  Pending   0  2m   web-1  Running          0  3m
```

`api-2` 가 crash-loop(재시작 0→7) 인 **새로 생긴 이상**, `web-1` 이 Pending→Running 인 **해결된 이상**이다. 사람이 보면 바로 알 수 있다.

그런데 parism 은 이렇게 말한다.

```
comparable=false domain=kubernetes changed=0
보류 사유: ["no metadata.uid: a recreated resource with the same name cannot be told apart from an existing one",
           "identity could not be established for some rows, so the comparison is withheld rather than reported as complete"]
```

**이것이 의도된 정답이다.** 표 출력에는 `metadata.uid` 가 없다. 이름이 같은 자원이 재생성된 것인지 이미 있던 것인지 구분할 수 없다. 다른 무엇을 놓쳤다고 단정하면 그것이 거짓 변화다.

사람이 눈으로 보면 `api-2` 의 CrashLoopBackOff 를 즉시 알아챈다. parism 은 그걸 **비교로 말하지 않고 보류로 말한다.** 취향의 문제가 아니라 계약의 문제다 — "이건 확실히 다른 자원이다"라고 말할 근거가 없다.

### 채점 결과(21항목 전부 통과)

```
PASS  git 비교가 성립한다
PASS  새로 생긴 이상(c.txt: 미추적 → 스테이징)을 찾았다
PASS  해결된 이상(b.txt: 미스테이징 → 스테이징)을 찾았다
PASS  필드 변화에 근거를 붙인다 — 2/2건
PASS  무시한 필드를 밝힌다
PASS  픽스처가 목록을 실제로 늘렸다 — 2 → 3
PASS  나머지 행을 거짓 변화로 잡지 않는다 — changed=0 removed=0
PASS  새로 들어온 1건만 '추가'로 잡는다
PASS  같은 결과를 두 번 비교하면 변화 0 — unchanged=2
PASS  잘렸음을 review 가 밝힌다 — truncated=true source_complete=false
PASS  잘린 이유를 warnings 로 밝힌다
PASS  잘린 결과에서 거짓 삭제를 만들지 않는다 — removed=0
PASS  불완전함을 감추지 않는다
PASS  uid 없는 표는 비교를 보류한다 — comparable=false
PASS  보류 사유를 말해 준다
PASS  보류 상태에서 거짓 변경을 내지 않는다 — changed=0 added=0 removed=0
PASS  파서가 표를 행 배열로 읽는다 — 3행
PASS  비교를 두 번 해도 결과가 같다
PASS  보관 안 된 결과는 재실행 없이 거절한다 — result_not_retained
```

---

## 부록 C. 이 하네스가 잡은 결함 3건

하네스를 짜는 동안 제품 결함이 세 개 나왔다. **모두 하네스가 실제 저장소·실제 원문과 대조하다가 드러났다.**

### C-1. `retain: false` 로 발급한 id 의 거절 사유가 잘못됐다

`run` 은 `retain: true` 가 없어도 `review.result_id` 를 돌려준다(사용자가 `retained: false` 를 보고 안다). 그런데 그 id 로 `explain_result` 를 부르면 `unknown_id` 가 났다.

```
요청 안 함 → review.result_id = "r_..." , retained = false
explain_result("r_...") → unknown_id        ← '처음부터 보관 안 했다'는 사실이 사라짐
```

타입에는 `not_retained` 이 선언돼 있었지만 **어디서도 나오지 않았다.** `unknown_id`(이 세션이 모르는 id)와 `not_retained`(처음부터 보관하지 않음)은 원인이 다르다. 합치면 무엇을 해야 하는지 알 수 없다.

수정: `ResultStore.markNotRetained()` 추가, `retain: false` 일 때 그 사실을 기록. `explain_result` 는 `not_retained` 을 돌려준다. 회귀 시험 3건.

### C-2. git 행 identity 가 프로세스 cwd 에 의존했다

```
gitStatusIdentity({ path: "src/a.ts" }, "/tmp/xxx/repo", {}).key
→ "/tmp/xxx/repo /home/nirna/jobs/parism/src/a.ts"
```

`normalizePath` 가 `resolve(value)` 를 썼는데 `resolve` 는 **프로세스 cwd** 기준이다. 저장소 identity 가 파라미터로 넘어오면서도 쓰이지 않았다. 결과적으로 **같은 저장소의 같은 파일이 실행 위치마다 다른 key** 를 갖는다. 비교가 성립하지 않는 진짜 이유가 될 수 있다.

수정: 저장소 기준(`resolve(repoIdentity, value)`)으로 정규화. 회귀 시험 2건(상대/절대 경로 일치, cwd 비의존).

### C-3. `comparable` 이 항상 `true` 였고 `key_conflicts` 는 항상 빈 배열이었다

identity 를 확정하지 못한 행이 있어 `partial.withheld_reasons` 에 사유를 남기면서도 `comparable: true` 를 돌려줬다. "비교가 성립했다"와 "비교하지 못했다"가 동시에 말해지는 셈이다.

같은 자리에서 `key_conflicts` 를 빈 배열로 버리고 있었다. 중복 identity 를 찾아놓고 결과를 안 알려주면 조용히 한 행을 버린 셈이 된다.

수정: `comparable` 을 보류 사유 유무에 따라 계산하고, `key_conflicts` 를 실제 값을 돌려준다. 회귀 시험 2건.

### 부수 개선: `label` 필드

`CompareRowResult.key` 는 `저장소identity<NUL>경로` 형식이라 사람이 읽을 수 없다. 무엇이 변했는지 말하려면 이름이 보여야 하므로 `label` 을 함께 준다. **`key` 는 그대로 둔다** — 비교·대조용 식별자다.

---

## 부록 D. 하네스 작성 중 내가 낸 실수

제품 결함과 별개로, 하네스 자체가 여러 번 틀렸고 그때마다 제품이 정상인데 하네스만 실패했다.

| 실수 | 어떻게 알았나 |
|---|---|
| `withTemp` 가 비동기 콜백을 await 하지 않아 fixture 를 첫 실행 직후 삭제 | 첫 `spawn` 만 성공하고 이후 전부 `ENOENT`. `dir 존재` 를 찍어 발견 |
| `find` 접두사(`./`) 차이를 오답으로 셌다 | 경로 집합은 같은데 recall 이 0 |
| `find` 에 `evidence` 를 요구했다 | `find` 는 M1 근거 MVP 파서가 아니다. `ps`·`git porcelain` 이다 |
| `c.txt` 를 커밋해 버려 "미추적" 상태가 안 됐다 | `git add` 후에도 status 가 빈 것 |
| c.txt 를 커밋한 채 "미추적 → 스테이징" 을 기대했다 | 기대한 현상이 픽스처에 없음 |
| porcelain 출력 순서를 뒤집으려다 불가능함을 무시 | `git status` 는 경로순 정렬. 순서만 다른 입력을 만들 수 없다 |

**마지막 항목은 계획서 가정("순서 변화와 잘린 결과를 섞어")가 이 도메인에서 완전히 성립하지 않는다는 뜻이다.** git porcelain 은 경로순으로 정렬해 같은 파일 집합으로는 순서를 뒤집을 수 없다. 그래서 하네스는 "목록이 1건 늘어남"으로 그 자리를 대신 채우고 **그 사실을 코드 주석에 남겼다.**

---

## 부록 E. 아직 하지 않은 것

| 항목 | 이유 |
|---|---|
| 경쟁 도구(jc 등)와의 비교 | "해당 작업을 정상 지원하는 동일 조건에서만 비교"가 필요하다. 설치·판정 기준을 먼저 정해야 한다. **지원 범위가 다른 도구에 억지로 실패를 부여하지 않는다** |
| 5~8명 실험 실행 | 사람 개입이 필요하다 |
| 토큰 절감률 측정 | 현 fixture 에서 축약이 발생하지 않았다. fixture 를 키우고 예산을 낮춰야 하며 **절감 수치를 광고하기 전 5~8명 결과가 필요하다** |
| 30개 과제 · 5회 반복 | 실험 설계가 먼저다. 고정 모델·버전·온도·프롬프트와 confidence interval, 원시 집계 방법이 필요하다 |
| 성능 게이트(10% 회귀, 1KB/100KB/1MB × concurrency 1/4/16) | 별도 측정. 이번 하네스와 다른 성격 |

---

## 재현 방법

```bash
npm run build
node experiments/experiment-a.mjs   # 19항목
node experiments/experiment-b.mjs   # 21항목
```

fixture 는 고정 시드(`SEED = 20261005`)로 만들어져 **같은 커밋에서 같은 입력이 나온다.** 임시 디렉터리는 실행이 끝나면 지워진다.
