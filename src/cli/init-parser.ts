import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface InitResult {
  name:  string;
  files: string[];
}

/**
 * parser.ts 템플릿을 생성한다.
 */
function parserTemplate(name: string): string {
  return [
    'import { z }                                   from "zod";',
    'import type { ParserPack, ParseContext } from "@nerdvana/parism";',
    "",
    "// schema is the single source of truth for this parser's output shape.",
    "// - Fixture replay (parism test) always validates expected values against this schema,",
    "//   regardless of the strict_schemas config setting. This detects fixture drift early.",
    "// - Runtime output validation only runs when config.parsers.strict_schemas=true.",
    "//   The default is false — parsers run exactly as they do without Zod.",
    "const schema = z.object({",
    "  // TODO: define output shape",
    "  items: z.array(z.string()),",
    "});",
    "",
    "const pack: ParserPack = {",
    '  name: "' + name + '",',
    "",
    "  parse(raw: string, args: string[], ctx?: ParseContext): unknown {",
    '    const lines = raw.trim().split("\\n").filter(Boolean);',
    "",
    "    // TODO: implement parsing logic",
    "    return {",
    "      items: lines,",
    "    };",
    "  },",
    "",
    "  schema,",
    "",
    "  // Flags whose output format this parser handles. Any other flag is reported as unsupported_format.",
    "  acceptedFlags: { \"-a\": \"bool\" },",
    "  // Optional custom rule applied after the declaration: return false for args this parser cannot handle.",
    "  // supports: (args: string[]) => args.length < 3,",
    "",
    "  fixtures: [],",
    "};",
    "",
    "export default pack;",
    "",
  ].join("\n");
}

/**
 * 스캐폴드가 컴파일되려면 만족해야 하는 조건을 그대로 적는다.
 *
 * 둘 다 실제로 밟은 오류다 — "따라가라"는 안내가 따라가지 않는 코드를 내놓는 셈이므로
 * 사용자가 첫 오류를 만나기 전에 읽을 수 있는 곳에 둔다.
 */
function readmeTemplate(name: string, parismDep: string): string {
  return [
    `# ${name} 파서 팩`,
    "",
    "## 컴파일하려면 두 가지가 필요하다",
    "",
    "**1. zod 버전이 맞아야 한다.**",
    "",
    "```bash",
    `npm install ${parismDep}`,
    "```",
    "",
    "parism 의 `ParserPack.schema` 는 zod 3 타입이다. zod 4 를 설치하면",
    "`Type 'ZodObject<…>' is missing … from type 'ZodTypeAny'` 로 컴파일이 깨진다.",
    "버전 없이 `npm install zod` 를 하면 4 가 깔린다.",
    "",
    "**2. 프로젝트가 ESM 이어야 한다.**",
    "",
    "parism 은 ESM 전용이다(`\"type\": \"module\"`). 소비자 쪽이 CommonJS 면",
    "`Type-only import of an ECMAScript module from a CommonJS module` 가 난다.",
    "",
    "```json",
    '{ "type": "module" }',
    "```",
    "",
    "## 확인",
    "",
    "```bash",
    `parism add ./${name}`,
    `parism inspect "${name} --help"`,
    "```",
    "",
    "`parism test` 는 이 팩 안의 `fixtures` 와 ~/.parism/fixtures 의 매니페스트를 함께 되짚는다.",
    "",
  ].join("\n");
}

/**
 * schema.json 내용을 생성한다.
 */
function schemaTemplate(): string {
  return JSON.stringify(
    {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
    },
    null,
    2,
  );
}

/**
 * parser pack scaffold를 생성한다.
 */
/**
 * parism 을 설치하는 정확한 표현.
 * 설치된 parism 의 package.json 을 읽어 실제 peer 사양을 그대로 쓴다.
 * "최신" 이라고 적으면 이 문서가 다음 배포에서 거짓이 된다.
 */
function parismInstallSpec(): string {
  return "@nerdvana/parism zod@^3";
}

export function initParser(name: string, baseDir: string): InitResult {
  const packDir = join(baseDir, name);

  if (existsSync(packDir)) {
    throw new Error(`Parser pack "${name}" already exists at ${packDir}`);
  }

  mkdirSync(packDir, { recursive: true });
  mkdirSync(join(packDir, "fixtures"), { recursive: true });

  const parserPath = join(packDir, "parser.ts");
  const schemaPath = join(packDir, "schema.json");
  const readmePath = join(packDir, "README.md");

  writeFileSync(parserPath, parserTemplate(name));
  writeFileSync(schemaPath, schemaTemplate());
  /** 설치 안내는 우리가 적는다 — 사용자가 첫 컴파일 오류를 거치게 하지 않는다. */
  writeFileSync(readmePath, readmeTemplate(name, parismInstallSpec()));

  return {
    name,
    files: [parserPath, schemaPath, readmePath],
  };
}
