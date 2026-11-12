/**
 * `parism skill install` 시험. 패키지에 든 스킬을 임시 저장소와 임시 홈에 실제로 복사한다.
 *
 * 작성자: 최진호
 * 작성일: 2026-11-12
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundledSkillDir, installSkill } from "../../src/cli/skill.js";

describe("skill install", () => {
  it("프로젝트와 사용자 범위에 스킬을 복사하고, 다시 실행하면 새 판으로 바꾼다", () => {
    const dir    = mkdtempSync(path.join(tmpdir(), "parism-skill-"));
    const source = readFileSync(path.join(bundledSkillDir(), "SKILL.md"), "utf8");
    const first  = installSkill({ cwd: dir });
    expect(first).toMatchObject({ target: path.join(dir, ".claude", "skills", "parism"), replaced: false });
    expect(first.version).toMatch(/^\d+\.\d+\.\d+$/);
    writeFileSync(path.join(first.target, "SKILL.md"), "old");
    expect(installSkill({ cwd: dir }).replaced).toBe(true);
    expect(readFileSync(path.join(first.target, "SKILL.md"), "utf8")).toBe(source);
    const user = installSkill({ scope: "user", home: dir });
    expect(user.target).toBe(path.join(dir, ".claude", "skills", "parism"));
    expect(() => installSkill({ cwd: dir, source: path.join(dir, "none") })).toThrow(/skill files not found/);
    rmSync(dir, { recursive: true, force: true });
  });
});
