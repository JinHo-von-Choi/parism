import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFind } from "../../src/parsers/fs/find.js";
import { parseDu } from "../../src/parsers/fs/du.js";
import { parseKubectl } from "../../src/parsers/devops/kubectl.js";

describe("find: 파일명의 앞뒤 공백", () => {
  it("줄바꿈 구분 출력에서도 이름 끝의 공백을 지우지 않는다", () => {
    const raw  = "./dir with space /inner  \n./trail \n./plain\n";
    const paths = (parseFind("find", ["."], raw) as { paths: string[] }).paths;
    expect(paths).toEqual(["./dir with space /inner  ", "./trail ", "./plain"]);
  });

  it("NUL 구분 출력과 같은 값을 낸다", () => {
    const lines  = "./dir with space /inner  \n./trail \n./plain\n";
    const byLine = (parseFind("find", ["."], lines) as { paths: string[] }).paths;
    const byNul  = (parseFind("find", ["-print0"], lines.replace(/\n/g, "\0")) as { paths: string[] }).paths;
    expect(byLine).toEqual(byNul);
  });

  it("실제 find 출력에서 공백이 든 이름이 보존된다", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "parism-find-"));
    try {
      writeFileSync(path.join(dir, "trail "), "x");
      mkdirSync(path.join(dir, "dir "), { recursive: true });
      writeFileSync(path.join(dir, "dir ", "inner  "), "y");

      const raw      = execFileSync("find", [".", "-type", "f"], { encoding: "utf8", cwd: dir });
      const paths    = (parseFind("find", ["."], raw) as { paths: string[] }).paths;
      expect(paths).toContain("./trail ");
      expect(paths).toContain("./dir /inner  ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("출력 끝의 빈 조각은 경로로 세지 않는다", () => {
    expect((parseFind("find", ["."], "./a\n./b\n") as { paths: string[] }).paths).toEqual(["./a", "./b"]);
  });
});

describe("du: 파일명의 앞뒤 공백", () => {
  it("경로 끝의 공백을 보존한다", () => {
    const raw  = "4\t./trail \n8\t./dir with space /inner  \n";
    const rows = (parseDu("du", ["-a"], raw) as { entries: Array<{ path: string }> }).entries;
    expect(rows.map(r => r.path)).toEqual(["./trail ", "./dir with space /inner  "]);
  });

  it("이름에 탭이 있어도 경로가 온전히 남는다", () => {
    const rows = (parseDu("du", ["-a"], "4\ta\tb\n") as { entries: Array<{ path: string }> }).entries;
    expect(rows[0]!.path).toBe("a\tb");
  });

  it("--time 형식에서도 경로 공백이 남는다", () => {
    const raw  = "4\t2026-01-02 03:04\treport \n";
    const rows = (parseDu("du", ["-a", "--time"], raw) as { entries: Array<{ path: string; modified_at?: string }> }).entries;
    expect(rows[0]!.path).toBe("report ");
    expect(rows[0]!.modified_at).toBe("2026-01-02 03:04");
  });
});

describe("kubectl: RESTARTS 뒤의 괄호 표기", () => {
  const header = "NAME                     READY   STATUS    RESTARTS   AGE";

  it("재시작 0인 행은 이전과 같다", () => {
    const raw   = `${header}\napi-1                      1/1     Running   0          3d\n`;
    const pods  = (parseKubectl("kubectl", ["get", "pods"], raw) as { pods: Array<Record<string, unknown>> }).pods;
    expect(pods[0]).toMatchObject({ name: "api-1", restarts: 0, lastRestart: null, age: "3d", ip: null, node: null });
  });

  it("괄호 표기가 있어도 AGE 가 밀리지 않는다", () => {
    const raw  = `${header}\napi-1                      1/1     Running   2 (5d ago) 8d\n`;
    const pods = (parseKubectl("kubectl", ["get", "pods"], raw) as { pods: Array<Record<string, unknown>> }).pods;
    expect(pods[0]).toMatchObject({ restarts: 2, lastRestart: "(5d ago)", age: "8d", ip: null, node: null });
  });

  it("여러 단어 괄호 표기도 AGE 를 지킨다", () => {
    const raw  = `${header}\napi-1                      1/1     Running   7 (12h)    1d\n`;
    const pods = (parseKubectl("kubectl", ["get", "pods"], raw) as { pods: Array<Record<string, unknown>> }).pods;
    expect(pods[0]).toMatchObject({ restarts: 7, lastRestart: "(12h)", age: "1d" });
  });

  it("괄호 표기 뒤의 IP 와 NODE 를 그대로 읽는다", () => {
    const raw  = `${header}\napi-1                      1/1     Running   2 (5d ago) 8d   10.0.0.5   node-a\n`;
    const pods = (parseKubectl("kubectl", ["get", "pods"], raw) as { pods: Array<Record<string, unknown>> }).pods;
    expect(pods[0]).toMatchObject({ restarts: 2, lastRestart: "(5d ago)", age: "8d", ip: "10.0.0.5", node: "node-a" });
  });

  it("괄호가 닫히지 않은 행은 열을 밀지 않는다", () => {
    const raw  = `${header}\napi-1                      1/1     Running   2 (5d ago  8d\n`;
    const pods = (parseKubectl("kubectl", ["get", "pods"], raw) as { pods: Array<Record<string, unknown>> }).pods;
    expect(pods[0]!.age).toBe("(5d");
    expect(pods[0]!.lastRestart).toBeNull();
  });
});
