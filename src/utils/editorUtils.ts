import { CompletionContext } from "@codemirror/autocomplete";

export function findHeaderLine(doc: any, header: string): number | null {
  const cleanHeader = header.toLowerCase().replace(/^#+\s+/, "").trim();
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text.trim();
    if (text.startsWith("#")) {
      const textClean = text.toLowerCase().replace(/^#+\s+/, "").trim();
      if (textClean === cleanHeader) {
        return i;
      }
    }
  }
  return null;
}

export function wikiCompletionSource(context: CompletionContext, markdownFilesSet: Set<string>) {
  const word = context.matchBefore(/\[\[[^\]]*$/);
  if (!word) return null;
  const typed = word.text.slice(2);
  const options = Array.from(markdownFilesSet).map(name => {
    const displayName = name.endsWith(".md") ? name.slice(0, -3) : name;
    return {
      label: displayName,
      type: "variable",
      apply: displayName
    };
  });
  return {
    from: word.from + 2,
    options: options.filter(opt => opt.label.toLowerCase().includes(typed.toLowerCase()))
  };
}

export function computeWordCount(content: string): number {
  return content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

interface MergeResult {
  success: boolean;
  mergedText: string;
}

export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const getDiff = (a: string[], b: string[]) => {
    const n = a.length;
    const m = b.length;
    const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
    
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    
    let i = n, j = m;
    const diff: { type: "add" | "delete" | "eq"; line: string; indexA: number; indexB: number }[] = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        diff.push({ type: "eq", line: a[i - 1], indexA: i - 1, indexB: j - 1 });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        diff.push({ type: "add", line: b[j - 1], indexA: -1, indexB: j - 1 });
        j--;
      } else {
        diff.push({ type: "delete", line: a[i - 1], indexA: i - 1, indexB: -1 });
        i--;
      }
    }
    return diff.reverse();
  };

  interface Hunk {
    baseStart: number;
    baseEnd: number;
    lines: string[];
  }
  
  const getHunks = (diff: ReturnType<typeof getDiff>): Hunk[] => {
    const hunks: Hunk[] = [];
    let currentHunk: Hunk | null = null;
    let baseCursor = 0;
    
    for (const item of diff) {
      if (item.type === "eq") {
        if (currentHunk) {
          hunks.push(currentHunk);
          currentHunk = null;
        }
        baseCursor = item.indexA + 1;
      } else if (item.type === "delete") {
        if (!currentHunk) {
          currentHunk = { baseStart: item.indexA, baseEnd: item.indexA + 1, lines: [] };
        } else {
          currentHunk.baseEnd = item.indexA + 1;
        }
        baseCursor = item.indexA + 1;
      } else if (item.type === "add") {
        if (!currentHunk) {
          currentHunk = { baseStart: baseCursor, baseEnd: baseCursor, lines: [item.line] };
        } else {
          currentHunk.lines.push(item.line);
        }
      }
    }
    if (currentHunk) {
      hunks.push(currentHunk);
    }
    return hunks;
  };

  try {
    const diffL = getDiff(baseLines, localLines);
    const diffR = getDiff(baseLines, remoteLines);
    
    const hunksL = getHunks(diffL);
    const hunksR = getHunks(diffR);
    
    for (const hL of hunksL) {
      for (const hR of hunksR) {
        const startOverlap = Math.max(hL.baseStart, hR.baseStart);
        const endOverlap = Math.min(hL.baseEnd, hR.baseEnd);
        
        const overlaps = startOverlap < endOverlap;
        const insertAtSamePoint = hL.baseStart === hL.baseEnd && hR.baseStart === hR.baseEnd && hL.baseStart === hR.baseStart;
        
        if (overlaps || insertAtSamePoint) {
          const sameContent = hL.lines.length === hR.lines.length && hL.lines.every((line, idx) => line === hR.lines[idx]);
          if (!sameContent) {
            return { success: false, mergedText: "" };
          }
        }
      }
    }
    
    const mergedLines: string[] = [];
    const allHunksRaw: { side: "L" | "R"; hunk: Hunk }[] = [
      ...hunksL.map(h => ({ side: "L" as const, hunk: h })),
      ...hunksR.map(h => ({ side: "R" as const, hunk: h }))
    ];
    allHunksRaw.sort((a, b) => a.hunk.baseStart - b.hunk.baseStart);
    
    const allHunks: { side: "L" | "R"; hunk: Hunk }[] = [];
    for (const item of allHunksRaw) {
      const isDuplicate = allHunks.some(existing => 
        existing.hunk.baseStart === item.hunk.baseStart &&
        existing.hunk.baseEnd === item.hunk.baseEnd &&
        existing.hunk.lines.length === item.hunk.lines.length &&
        existing.hunk.lines.every((line, idx) => line === item.hunk.lines[idx])
      );
      if (!isDuplicate) {
        allHunks.push(item);
      }
    }
    
    let lastAppliedEnd = 0;
    for (const { hunk } of allHunks) {
      if (hunk.baseStart > lastAppliedEnd) {
        mergedLines.push(...baseLines.slice(lastAppliedEnd, hunk.baseStart));
      }
      
      if (hunk.baseStart >= lastAppliedEnd) {
        mergedLines.push(...hunk.lines);
        lastAppliedEnd = hunk.baseEnd;
      }
    }
    
    if (lastAppliedEnd < baseLines.length) {
      mergedLines.push(...baseLines.slice(lastAppliedEnd));
    }
    
    return { success: true, mergedText: mergedLines.join("\n") };
  } catch (e) {
    console.error("Three-way merge failed:", e);
    return { success: false, mergedText: "" };
  }
}

export interface DiffLine {
  type: "added" | "removed" | "unchanged";
  value: string;
}

export function computeSimpleLineDiff(localStr: string, diskStr: string): DiffLine[] {
  const localLines = localStr.split("\n");
  const diskLines = diskStr.split("\n");
  
  if (localLines.length * diskLines.length > 1000000) {
    const result: DiffLine[] = [];
    localLines.forEach(line => result.push({ type: "removed", value: line }));
    diskLines.forEach(line => result.push({ type: "added", value: line }));
    return result;
  }
  
  const dp: number[][] = Array(localLines.length + 1).fill(null).map(() => Array(diskLines.length + 1).fill(0));
  
  for (let i = 1; i <= localLines.length; i++) {
    for (let j = 1; j <= diskLines.length; j++) {
      if (localLines[i - 1] === diskLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  const diffResult: DiffLine[] = [];
  let i = localLines.length;
  let j = diskLines.length;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && localLines[i - 1] === diskLines[j - 1]) {
      diffResult.push({ type: "unchanged", value: localLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffResult.push({ type: "added", value: diskLines[j - 1] });
      j--;
    } else {
      diffResult.push({ type: "removed", value: localLines[i - 1] });
      i--;
    }
  }
  
  return diffResult.reverse();
}
