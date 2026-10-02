/**
 * 설정 레이어 검증.
 * 전역·프로젝트 설정 파일과 환경 변수에서 읽은 값을 필드 단위로 검사한다.
 * 형식이 틀린 필드는 stderr에 한 번 경고하고 버린다. 버린 필드는 아래 레이어의 값(기준값)을 유지한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-10-03
 */

import { z } from "zod";
import type { PrismConfig } from "./loader.js";

/** 수치 상한: 유한한 0 이상 정수 */
export const LIMIT_SCHEMA = z.number().int().nonnegative();

/** 0을 무제한으로 쓰지 않는 상한: 1 이상 정수 */
const POSITIVE_LIMIT_SCHEMA = z.number().int().positive();

const STRING_LIST    = z.array(z.string());
const FLAG_KIND      = z.enum(["bool", "value", "path", "attached", "count"]);
const SUB_POSITIONAL = z.enum(["path", "any", "none"]);

/** CommandPolicy 형식. 알 수 없는 키가 있으면 오타로 보고 항목 전체를 거부한다. */
const COMMAND_POLICY_SCHEMA = z.object({
  subcommands:      STRING_LIST.optional(),
  flags:            z.record(FLAG_KIND),
  positionals:      z.enum(["path", "any", "none", "url"]),
  singleDashLong:   z.boolean().optional(),
  subPositionals:   z.record(SUB_POSITIONAL).optional(),
  leadingFlags:     STRING_LIST.optional(),
  numericFlag:      z.boolean().optional(),
  subVerbs:         z.record(STRING_LIST).optional(),
  fileRefFlags:     STRING_LIST.optional(),
  deniedValues:     z.record(STRING_LIST).optional(),
  stopAtPositional: z.boolean().optional(),
  subFlags:         z.record(z.record(FLAG_KIND)).optional(),
  allowedValues:    z.record(STRING_LIST).optional(),
}).strict();

const ARG_RESTRICTION_SCHEMA = z.object({ blocked_flags: STRING_LIST }).strict();

/**
 * 필드 명세.
 * zod 스키마: 값 전체를 한 번에 검사한다.
 * fields: 객체의 하위 키를 각각 검사한다.
 * entries: 임의 키 객체의 항목을 각각 같은 스키마로 검사한다.
 */
type FieldSpec =
  | z.ZodTypeAny
  | { fields:  Record<string, FieldSpec> }
  | { entries: z.ZodTypeAny };

const GUARD_FIELDS: Record<string, FieldSpec> = {
  allowed_commands:         STRING_LIST,
  allowed_paths:            STRING_LIST,
  timeout_ms:               LIMIT_SCHEMA,
  max_output_bytes:         LIMIT_SCHEMA,
  max_items:                LIMIT_SCHEMA,
  default_page_size:        LIMIT_SCHEMA,
  max_page_size:            POSITIVE_LIMIT_SCHEMA,
  max_concurrency:          POSITIVE_LIMIT_SCHEMA,
  block_patterns:           STRING_LIST,
  command_arg_restrictions: { entries: ARG_RESTRICTION_SCHEMA },
  command_policies:         { entries: COMMAND_POLICY_SCHEMA },
  profile:                  z.enum(["readonly", "build"]),
  secrets:                  {
    fields: {
      env_patterns:             STRING_LIST,
      output_patterns:          STRING_LIST,
      output_redaction_enabled: z.boolean(),
    },
  },
};

const CONFIG_FIELDS: Record<string, FieldSpec> = {
  guard:                { fields: GUARD_FIELDS },
  trust_project_config: z.boolean(),
  parsers:              {
    fields: {
      strict_schemas:            z.boolean(),
      adaptive_format_threshold: {
        fields: {
          json:        LIMIT_SCHEMA,
          compact:     LIMIT_SCHEMA,
          json_no_raw: LIMIT_SCHEMA,
        },
      },
    },
  },
  telemetry:            { fields: { enabled: z.boolean() } },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnInvalid(name: string, source: string, detail: string): void {
  process.stderr.write(`[parism] WARNING: ignored invalid ${name} in ${source}: ${detail}\n`);
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid value";
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/**
 * 객체의 각 키를 명세로 검사해 유효한 값만 담은 새 객체를 만든다.
 * 명세에 없는 키는 조용히 버린다. 객체 프로토타입 키는 자기 속성일 때만 검사한다.
 */
function pickValid(
  input:  Record<string, unknown>,
  fields: Record<string, FieldSpec>,
  prefix: string,
  source: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(input, key)) continue;
    const name  = prefix + key;
    const value = validateField(input[key], spec, name, source);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 한 필드를 명세로 검사한다. 무효면 경고하고 undefined를 돌려준다. */
function validateField(value: unknown, spec: FieldSpec, name: string, source: string): unknown {
  if (spec instanceof z.ZodType) {
    const parsed = spec.safeParse(value);
    if (parsed.success) return parsed.data;
    warnInvalid(name, source, describeIssue(parsed.error));
    return undefined;
  }
  if (!isPlainObject(value)) {
    warnInvalid(name, source, "expected object");
    return undefined;
  }
  if ("fields" in spec) return pickValid(value, spec.fields, name + ".", source);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = spec.entries.safeParse(entry);
    if (parsed.success) out[key] = parsed.data;
    else                warnInvalid(`${name}.${key}`, source, describeIssue(parsed.error));
  }
  return out;
}

/**
 * 설정 파일 하나에서 읽은 JSON 값을 검사해 유효한 필드만 남긴 부분 설정을 돌려준다.
 * 최상위가 객체가 아니면 경고하고 빈 레이어로 본다.
 */
export function validateConfigLayer(raw: unknown, source: string): Partial<PrismConfig> {
  if (!isPlainObject(raw)) {
    process.stderr.write(`[parism] WARNING: ignored ${source}: top-level value must be an object\n`);
    return {};
  }
  return pickValid(raw, CONFIG_FIELDS, "", source) as Partial<PrismConfig>;
}
