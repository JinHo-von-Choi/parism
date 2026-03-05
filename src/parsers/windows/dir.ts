export interface DirEntry {
  name:        string;
  type:        "file" | "directory";
  size_bytes:  number | null;
  modified_at: string | null;
}

export interface DirResult {
  directory:   string | null;
  entries:     DirEntry[];
  total_files: number;
  total_dirs:  number;
  free_bytes:  number | null;
}

/**
 * Parses Windows `dir` command output.
 * Handles both /b (bare) and default verbose output.
 */
export function parseDir(_cmd: string, _args: string[], raw: string): DirResult {
  const lines      = raw.split(/\r?\n/);
  const entries:   DirEntry[] = [];
  let   directory: string | null = null;
  let   totalFiles = 0;
  let   totalDirs  = 0;
  let   freeBytes: number | null = null;

  // Detect bare mode (/b): no header, no summary
  const hasDirHeader = raw.includes("Directory of ") || raw.includes("Volume in drive");
  if (!hasDirHeader) {
    for (const line of lines) {
      const name = line.trim();
      if (!name) continue;
      entries.push({ name, type: "file", size_bytes: null, modified_at: null });
    }
    return { directory: null, entries, total_files: entries.length, total_dirs: 0, free_bytes: null };
  }

  // Verbose mode
  const dirMatch = raw.match(/Directory of (.+)/);
  if (dirMatch) directory = dirMatch[1].trim();

  // Entry: "01/15/2026  10:30 AM    <DIR>          Desktop"
  //        "01/15/2026  10:30 AM         1,234,567 file.txt"
  const entryRe = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2} [AP]M)\s+(<DIR>|[\d,]+)\s+(.+)$/;

  for (const line of lines) {
    const m = line.match(entryRe);
    if (!m) continue;
    const [, datePart, timePart, sizePart, name] = m;
    if (name === "." || name === "..") continue;

    const isDir     = sizePart === "<DIR>";
    const sizeBytes = isDir ? null : parseInt(sizePart.replace(/,/g, ""), 10);

    entries.push({
      name,
      type:        isDir ? "directory" : "file",
      size_bytes:  sizeBytes,
      modified_at: `${datePart} ${timePart}`,
    });
  }

  // " 2 File(s)  1,234 bytes"
  const fileM = raw.match(/(\d[\d,]*) File\(s\)/);
  if (fileM) totalFiles = parseInt(fileM[1].replace(/,/g, ""), 10);

  // " 3 Dir(s)  50,000,000 bytes free"
  const dirM = raw.match(/(\d[\d,]*) Dir\(s\)\s+([\d,]+) bytes free/);
  if (dirM) {
    totalDirs = parseInt(dirM[1].replace(/,/g, ""), 10);
    freeBytes = parseInt(dirM[2].replace(/,/g, ""), 10);
  }

  return { directory, entries, total_files: totalFiles, total_dirs: totalDirs, free_bytes: freeBytes };
}
