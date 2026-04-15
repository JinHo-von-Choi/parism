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
    "  fixtures: [],",
    "};",
    "",
    "export default pack;",
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
export function initParser(name: string, baseDir: string): InitResult {
  const packDir = join(baseDir, name);

  if (existsSync(packDir)) {
    throw new Error(`Parser pack "${name}" already exists at ${packDir}`);
  }

  mkdirSync(packDir, { recursive: true });
  mkdirSync(join(packDir, "fixtures"), { recursive: true });

  const parserPath = join(packDir, "parser.ts");
  const schemaPath = join(packDir, "schema.json");

  writeFileSync(parserPath, parserTemplate(name));
  writeFileSync(schemaPath, schemaTemplate());

  return {
    name,
    files: [parserPath, schemaPath],
  };
}
