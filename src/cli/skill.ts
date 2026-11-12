/**
 * `parism skill install`: 패키지에 든 에이전트 스킬(skills/parism)을 Claude Code 스킬 디렉터리에 복사한다.
 *
 * 스킬은 에이전트가 Parism 도구를 적은 토큰으로 쓰는 방법(명령 한 줄, 행 투영, query_result, 시험 러너, 태스크)을 담는다.
 * project 범위는 현재 저장소의 .claude/skills/parism, user 범위는 ~/.claude/skills/parism이다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { cpSync, existsSync, readFileSync } from "node:fs";
import path              from "node:path";
import { fileURLToPath } from "node:url";

/** 패키지 안의 스킬 원본. dist/cli/skill.js 기준으로 패키지 루트의 skills/parism이다. */
export function bundledSkillDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "parism");
}

export interface SkillInstallResult {
  target:   string;
  replaced: boolean;
  version:  string | undefined;
}

/** 스킬을 복사한다. 이미 있으면 새 판으로 바꾼다. */
export function installSkill(options: { scope?: "project" | "user"; cwd?: string; home?: string; source?: string } = {}): SkillInstallResult {
  const source = options.source ?? bundledSkillDir();
  if (!existsSync(path.join(source, "SKILL.md"))) throw new Error(`skill files not found at ${source}`);
  const base   = options.scope === "user" ? (options.home ?? process.env.HOME ?? "") : (options.cwd ?? process.cwd());
  if (base === "") throw new Error("HOME is not set; use --scope project");
  const target   = path.join(base, ".claude", "skills", "parism");
  const replaced = existsSync(path.join(target, "SKILL.md"));
  cpSync(source, target, { recursive: true, force: true });
  const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(target, "SKILL.md"), "utf8"))?.[1];
  return { target, replaced, version };
}
