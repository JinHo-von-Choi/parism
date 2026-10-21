/**
 * 토큰 예산을 이미 얻은 결과에 적용하는 모듈.
 *
 * ## 왜 분리했나
 *
 * 예산 적용은 **결과를 어디까지 내보낼지** 정하는 일이다. 실행시간이나 수집량을 줄이는
 * 기능이 아니다 — 그 구분이 이 코드 전체의 중심에 있다.
 *
 * 원래는 `ParismEngine` 의 private 메서드였다. 그런데 이 로직은 **엔진이 없어도** 돈다 —
 * 필요한 것은 (1) 파서 등록부, (2) 이어 읽기용 페이지 보관함, (3) 봉투 하나뿐이다.
 * private 메서드로 두면 이 계산을 시험하려면 엔진 전체를 세워야 했다.
 *
 * ## 이 모듈이 지키는 약속
 *
 * 예산이 상한을 넘으면 **거짓으로 참이라 하지 않는다.** `budget_met: false` 와
 * 명시적 누락 항목으로 알린다. 못 맞추는 것보다 아무 값도 못 받는 쪽이 나쁘다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-22
 */

import type { ParserRegistry }                                 from "../parsers/registry.js";
import type { ResponseEnvelope }                               from "../types/envelope.js";
import { countJsonTokens }                                     from "../engine/budget/tokenizer.js";
import { applyBudget, validateTokenizer, findRowArray }        from "../engine/budget/index.js";
import type { Continuation, CursorBinding }                    from "../engine/budget/index.js";
import { parseProjection }                                     from "../engine/projection.js";
import { hashContent }                                         from "../engine/evidence.js";
import { ENVELOPE_SCHEMA_VERSION }                             from "../engine/review.js";
import type { MaskedRange }                                    from "../engine/mask-map.js";
import { budgetReportPlaceholder, type RunOptions }            from "./envelope.js";

/** 예산으로 잘라 낸 결과를 이어 읽기할 때 보관하는 원본 행. */
export type PageStore = Map<string, { rows: unknown[]; binding: CursorBinding }>;

export interface RunBudgetContext {
  cmd: string; args: string[]; cwd: string; maskRanges: readonly MaskedRange[];
  parsed: unknown; projection: ReturnType<typeof parseProjection> | undefined;
  native: boolean; resultId?: string;
}

export interface RunBudgetOutcome {
  budget: unknown; omission: unknown; shrunkParsed: unknown; continuation?: Continuation;
}

/**
 * 이미 얻은 결과를 예산 안에 넣고 표면에 예산·누락 내역을 실는다.
 * 실행시간이나 수집량을 줄이지 않는다 — 어디까지 내보낼지만 정한다.
 */
export function applyRunBudget(
  envelope: ResponseEnvelope,
  budget: NonNullable<RunOptions["budget"]>,
  ctx: RunBudgetContext,
  deps: { registry: ParserRegistry; pages: PageStore },
): RunBudgetOutcome {
  const tokenizer = validateTokenizer(budget.tokenizer);
  if (!tokenizer.ok) {
    return {
      budget: {
        requested: { max_tokens: budget.max_tokens, tokenizer: budget.tokenizer ?? "parism/approx" },
        measured_tokens: 0, tokenizer_id: "", tokenizer_version: "",
        budget_met: false, tokenizer_exact: false, tokenizer_scope: "", error: tokenizer.message,
      },
      omission: [{ stage: "budget", reason: tokenizer.message }],
      shrunkParsed: envelope.stdout.parsed,
    };
  }

  const shape      = deps.registry.contractFor(ctx.cmd, ctx.args);
  const identity   = shape?.rowFields ?? [];
  const parsed     = (envelope.stdout.parsed ?? ctx.parsed) as unknown;
  const value      = findRowArray(parsed) === null ? parsed : parsed;
  const silentEmpty = envelope.failure?.reason === "unrecognized_output";
  const parseFailed = envelope.failure?.kind === "parse" && envelope.failure.reason === "parser_not_found";

  const outcome = applyBudget({
    value,
    budget: { ...budget, tokenizer: tokenizer.id },
    identityFields: [...identity],
    resultId: ctx.resultId ?? "unretained",
    binding: {
      content_hash:   hashContent(envelope.stdout.raw),
      schema_version: ENVELOPE_SCHEMA_VERSION,
      policy:         JSON.stringify({
        args: ctx.args, cwd: ctx.cwd,
        where: ctx.projection?.ok ? ctx.projection.options.where ?? null : null,
        sort: ctx.projection?.ok ? ctx.projection.options.sort_by ?? null : null,
        array: ctx.projection?.ok ? ctx.projection.options.array ?? null : null,
        required: budget.required_fields ?? [],
      }),
    },
    captureTruncated:  envelope.truncated === true,
    silentEmpty,
    parseFailed,
    privacyApplied:    ctx.maskRanges.length > 0,
    projectionOmitted: 0,
    /**
     * '후보 값을 넣은 실제 응답' 전체를 재야 한다.
     * 값만 재면 표면이 빠져 실제 응답이 상한을 넘는데도 budget_met 이 참이 된다.
     */
    measure: (candidate, surface) => countJsonTokens(
      { ...envelope, budget: budgetReportPlaceholder(budget.max_tokens, tokenizer.id), ...surface,
        stdout: { ...envelope.stdout, parsed: candidate } },
      tokenizer.id,
    ),
  });

  /**
   * 이어 읽기는 재실행 없이 같은 결과에서 이어 가야 한다.
   * 원본 행 전체를 이 세션에 담아 두고, cursor 에는 진행 규칙과 오프셋만 싣는다.
   */
  if (outcome.continuation && ctx.resultId) {
    const found = findRowArray(parsed);
    if (found) {
      deps.pages.set(ctx.resultId, {
        rows:    found.rows,
        binding: {
          result_id: ctx.resultId,
          content_hash:   hashContent(envelope.stdout.raw),
          schema_version: ENVELOPE_SCHEMA_VERSION,
          policy:         outcome.continuation ? "" : "",
        },
      });
    }
  }

  /**
   * ## 최종 상한 검증 — 계획서 M2 "최종 상한 검증"
   *
   * 예산을 적용할 때 재는 것은 **본문 + 표면**(누락 내역·진행 정보) 까지다.
   * 그런데 **예산 보고(`budget`)와 누락 목록(`omission`) 은 그 뒤에 붙는다.**
   * 그러면 소비자가 실제로 받는 응답이 재었던 것보다 커진다.
   *
   * 실측: `max_tokens: 1400` 요청 → `measured_tokens: 1330`, `budget_met: true`
   * → **실제 전달 응답 1,939 토큰. 상한의 138%다.**
   * `budget_met: true` 는 소비자가 지불하는 비용에 대해 참이 아니었고,
   * SPECIFICATION 의 정의("최종 payload 를 실제로 센 수")와 어긋났다.
   *
   * 보고가 자기 크기를 담는 자기 참조 필드(`measured_tokens`)를 가지므로 한 번의 측정으로는
   * 닫히지 않는다. 그래서 **확인 단계에서 실제 응답을 한 번 더 재고**, 아직 넘으면 넘은 만큼
   * 상한을 낮춰 **한 번만** 다시 적용한다.
   *
   * **한 번만**인 이유: 줄일 때마다 누락 항목이 자라 그만큼 다시 커진다. 줄이는 값과
   * 자라는 값이 싸우다 끝내 상한을 못 맞췄다(실측: 5,000 상한을 3회 시도 후에도 5,340).
   * 그래도 못 맞추면 **거짓으로 참이라 하지 않고** `budget_met: false` 와 명시적 누락 항목으로
   * 알린다. **못 맞추는 것보다 아무 값도 못 받는 쪽이 나쁘다** — 그래서 줄이지 않은 쪽을
   * 그대로 둔다.
   */
  const measureDelivered = (o: typeof outcome): number =>
    countJsonTokens(JSON.stringify({
      ...envelope,
      budget: o.report,
      omission: o.omissions,
      ...(o.continuation && { continuation: o.continuation }),
      stdout: { ...envelope.stdout, parsed: o.value },
    }), tokenizer.id);

  const applyWith = (maxTokens: number) => applyBudget({
    value, budget: { ...budget, max_tokens: maxTokens, tokenizer: tokenizer.id },
    identityFields: [...identity],
    resultId: ctx.resultId ?? "unretained",
    binding: {
      content_hash:   hashContent(envelope.stdout.raw),
      schema_version: ENVELOPE_SCHEMA_VERSION,
      policy: JSON.stringify({
        args: ctx.args, cwd: ctx.cwd,
        where: ctx.projection?.ok ? ctx.projection.options.where ?? null : null,
        sort: ctx.projection?.ok ? ctx.projection.options.sort_by ?? null : null,
        array: ctx.projection?.ok ? ctx.projection.options.array ?? null : null,
        required: budget.required_fields ?? [],
      }),
    },
    captureTruncated:  envelope.truncated === true,
    silentEmpty,
    parseFailed,
    privacyApplied:    ctx.maskRanges.length > 0,
    projectionOmitted: 0,
    measure: (candidate, surface) => countJsonTokens(
      { ...envelope, ...surface, stdout: { ...envelope.stdout, parsed: candidate } },
      tokenizer.id,
    ),
  });

  /**
   * 넘은 만큼만큼 상한을 낮춰 다시 적용한다.
   *
   * **맞으면 줄인 쪽을 쓴다. 안 맞으면 줄이지 않은 쪽을 그대로 둔다.**
   * 상한을 맞추다는 이유로 행을 0개까지 지우면 값이 사라지는 방향으로 나아간다 —
   * 상한에 못 미치는 것과 아무 값도 못 받는 것 중 어느 쪽이 나은지 자명하다.
   * 그래서 **들어온 시점에서 멈추고, 정직하게 '못 맞췄다' 고 말한다.**
   */
  const original = outcome;
  let   final    = original;
  let   delivered = measureDelivered(final);
  /**
   * 위에서 **검색 단계가 이미 보고 비용을 포함해 쟀으므로** 여기서는 한 번 확인하면 된다.
   * 이전처럼 반복해서 행을 줄이면, 줄일 때마다 누락 항목이 자라 그만큼 다시 커진다 —
   * 줄어드는 값과 자라는 값이 싸우다 끝내 상한을 못 맞춘다.
   * (실측: 5,000 상한을 3회 시도하고도 못 맞췄다.)
   */
  if (delivered > budget.max_tokens) {
    const tighter = budget.max_tokens - (delivered - budget.max_tokens);
    if (tighter > 0) {
      const next = applyWith(tighter);
      const size = measureDelivered(next);
      if (size <= budget.max_tokens) { final = next; delivered = size; }
    }
  }

  if (delivered > budget.max_tokens) {
    /**
     * **알림 항목부터 붙인 뒤에 다시 잰다.**
     *
     * 순서가 중요했다. 알림을 붙인 **다음에** 재야 그 알림이 차지하는 크기까지
     * `measured_tokens` 에 들어간다. 알림을 붙이고 이전 수치를 적으면
     * '최종 payload 를 실제로 센 수' 라는 SPEC 정의와 어긋난다(실측: 70토큰 차이).
     */
    const notice = {
      stage: "budget",
      reason: `the response does not fit the ${budget.max_tokens} token cap even after trimming rows: the envelope and this report alone cost more than the cap`,
    };
    const omissions = [...final.omissions, notice];
    const real = countJsonTokens(JSON.stringify({
      ...envelope,
      budget: { ...final.report, measured_tokens: 0, budget_met: false },
      omission: omissions,
      ...(final.continuation && { continuation: final.continuation }),
      stdout: { ...envelope.stdout, parsed: final.value },
    }), tokenizer.id);
    return {
      budget: { ...final.report, measured_tokens: real, budget_met: false },
      omission: omissions,
      shrunkParsed: final.value,
      ...(final.continuation && { continuation: final.continuation }),
    };
  }

  return {
    /** SPEC 의 정의대로 — 보고와 누락 목록까지 붙인 **최종 응답**의 토큰 수를 실린다 */
    budget:        { ...final.report, measured_tokens: delivered },
    omission:      final.omissions,
    shrunkParsed:  final.value,
    ...(final.continuation && { continuation: final.continuation }),
  };
}
