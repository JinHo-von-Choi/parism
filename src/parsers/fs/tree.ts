export interface TreeNode {
  name:     string;
  type:     "file" | "directory";
  children: TreeNode[];
}

export interface TreeResult {
  root:        TreeNode;
  directories: number;
  files:       number;
}

export function parseTree(cmd: string, args: string[], raw: string): TreeResult {
  const lines = raw.split("\n");

  // 마지막 요약 줄 파싱: "N directories, M files"
  let directories = 0;
  let files       = 0;
  const summaryLine = lines.findIndex(l => /\d+ director/.test(l));
  if (summaryLine >= 0) {
    const m = lines[summaryLine].match(/(\d+) director\S+.*?(\d+) file/);
    if (m) { directories = parseInt(m[1], 10); files = parseInt(m[2], 10); }
  }

  const contentLines = summaryLine >= 0 ? lines.slice(0, summaryLine) : lines;

  // 첫 줄이 루트 디렉토리명
  const rootName = contentLines[0]?.trim() || ".";
  const root: TreeNode = { name: rootName, type: "directory", children: [] };

  /** 들여쓰기 깊이는 접두부 4자 단위다. 유니코드(├── └──)와 ASCII(|-- `--) 연결자를 모두 받는다. */
  const ENTRY = /^((?:(?:│|\|) {3}| {4})*)(?:├── |└── |\|-- |`-- )(.+)$/;
  const items: Array<{ name: string; depth: number }> = [];
  for (const line of contentLines.slice(1)) {
    const m = line.match(ENTRY);
    if (m) items.push({ name: m[2]!.trim(), depth: m[1]!.length / 4 });
  }

  const stack: Array<{ node: TreeNode; depth: number }> = [{ node: root, depth: -1 }];

  items.forEach((item, idx) => {
    const isDir = (items[idx + 1]?.depth ?? -1) > item.depth;
    const node: TreeNode = { name: item.name, type: isDir ? "directory" : "file", children: [] };

    while (stack.length > 1 && stack[stack.length - 1]!.depth >= item.depth) stack.pop();

    stack[stack.length - 1]!.node.children.push(node);
    if (isDir) stack.push({ node, depth: item.depth });
  });

  return { root, directories, files };
}
