import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir }               from "node:os";
import path                     from "node:path";

/** 시험 프로세스가 쓰는 Parism 홈. 시험마다 PARISM_HOME을 따로 정한 곳은 그 값이 이긴다. */
export default function setup(): () => void {
  const home = mkdtempSync(path.join(tmpdir(), "parism-test-home-"));
  process.env.PARISM_HOME ??= home;
  return () => rmSync(home, { recursive: true, force: true });
}
