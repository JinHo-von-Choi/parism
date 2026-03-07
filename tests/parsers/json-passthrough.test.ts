import { describe, it, expect } from "vitest";
import { tryParseNativeJson } from "../../src/parsers/json-passthrough.js";

describe("tryParseNativeJson()", () => {
  it("유효한 JSON 객체를 파싱한다", () => {
    const raw = '{"name":"nginx","status":"running"}';
    expect(tryParseNativeJson(raw)).toEqual({ name: "nginx", status: "running" });
  });

  it("유효한 JSON 배열을 파싱한다", () => {
    const raw = '[{"id":1},{"id":2}]';
    expect(tryParseNativeJson(raw)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("JSON이 아닌 텍스트는 null을 반환한다", () => {
    expect(tryParseNativeJson("drwxr-xr-x  2 user group 4096")).toBeNull();
  });

  it("부분 JSON은 null을 반환한다", () => {
    expect(tryParseNativeJson('WARNING: something\n{"data":1}')).toBeNull();
  });

  it("빈 문자열은 null을 반환한다", () => {
    expect(tryParseNativeJson("")).toBeNull();
  });
});
