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
