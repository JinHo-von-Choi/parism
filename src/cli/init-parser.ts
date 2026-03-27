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
    'import type { ParserPack, ParseContext } from "@nerdvana/parism";',
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
    "  schema: {",
    '    type: "object",',
    "    properties: {",
    '      items: { type: "array", items: { type: "string" } },',
    "    },",
    "  },",
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
