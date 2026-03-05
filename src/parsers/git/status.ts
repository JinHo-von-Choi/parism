export interface GitStatus {
  branch:    string;
  staged:    string[];
  modified:  string[];
  untracked: string[];
}

export function parseGitStatus(cmd: string, args: string[], raw: string): GitStatus {
  const branchMatch = raw.match(/^On branch (.+)$/m);
  const branch      = branchMatch?.[1] ?? "unknown";

  const staged:    string[] = [];
  const modified:  string[] = [];
  const untracked: string[] = [];

  let section: "staged" | "modified" | "untracked" | null = null;

  for (const line of raw.split("\n")) {
    if (line.includes("Changes to be committed"))       { section = "staged";    continue; }
    if (line.includes("Changes not staged for commit")) { section = "modified";  continue; }
    if (line.includes("Untracked files"))               { section = "untracked"; continue; }

    const fileMatch = line.match(/^\t(?:modified|new file|deleted)?:?\s*(.+)$/);
    if (fileMatch && section === "staged")   staged.push(fileMatch[1].trim());
    if (fileMatch && section === "modified") modified.push(fileMatch[1].trim());

    if (section === "untracked" && line.startsWith("\t") && !line.includes("(use")) {
      untracked.push(line.trim());
    }
  }

  return { branch, staged, modified, untracked };
}
