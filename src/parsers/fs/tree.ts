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

  // 스택 기반 트리 빌드
  // 각 라인의 들여쓰기 깊이를 계산 (├──, └──, │ 패턴)
  const stack: Array<{ node: TreeNode; depth: number }> = [{ node: root, depth: -1 }];

  for (const line of contentLines.slice(1)) {
    if (!line.trim()) continue;

    // 깊이 계산: ├──, └── 앞의 │와 공백 패턴 기준 4자 단위
    const cleanedPrefix = line.match(/^([│ ]*)[├└]/);
    if (!cleanedPrefix) continue;

    const depth       = Math.floor(cleanedPrefix[1].replace(/[^ │]/g, "").length / 4);
    const nameMatch   = line.match(/[├└]── (.+)$/);
    if (!nameMatch) continue;

    const name     = nameMatch[1].trim();
    const isDir    = !name.includes(".");
    const newNode: TreeNode = { name, type: isDir ? "directory" : "file", children: [] };

    // 현재 깊이보다 깊은 스택 항목 제거
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    stack[stack.length - 1].node.children.push(newNode);
    if (isDir) stack.push({ node: newNode, depth });
  }

  return { root, directories, files };
}
