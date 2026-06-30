import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";

// --- Helpers ---
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(path);
}

function resolveUrl(url: string, workspacePath: string): string {
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:")) {
    return url;
  }
  let absolutePath;
  if (isAbsolute(url)) {
    absolutePath = url;
  } else if (url.startsWith("Pasted image")) {
    absolutePath = `${workspacePath}/_/Assets/${url}`;
  } else {
    absolutePath = `${workspacePath}/${url}`;
  }
  return convertFileSrc(absolutePath);
}

// --- Widgets ---

class SceneBreakWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-scene-break";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-prose-bullet-marker";
    span.textContent = "• ";
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) {
    super();
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-prose-image-container";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.className = "cm-prose-image";
    container.appendChild(img);

    if (this.alt) {
      const caption = document.createElement("div");
      caption.className = "cm-prose-image-caption";
      caption.textContent = this.alt;
      container.appendChild(caption);
    }

    return container;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

class TableRowWidget extends WidgetType {
  constructor(readonly cells: string[], readonly isHeader: boolean) {
    super();
  }
  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = this.isHeader ? "cm-prose-table-row header" : "cm-prose-table-row";
    for (const cell of this.cells) {
      const cellEl = document.createElement("div");
      cellEl.className = "cm-prose-table-cell";
      cellEl.textContent = cell.trim();
      container.appendChild(cellEl);
    }
    return container;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// --- Cached decoration instances ---

const REPLACE = Decoration.replace({});
const BOLD = Decoration.mark({ class: "cm-prose-bold" });
const ITALIC = Decoration.mark({ class: "cm-prose-italic" });

function lineClass(cls: string, attrs?: Record<string, string>) {
  return Decoration.line({ attributes: { class: cls, ...attrs } });
}

// --- Inline mark helpers ---

interface Mark {
  from: number;
  to: number;
  dec: Decoration;
}

function collectInlineMarks(lineFrom: number, text: string, workspacePath: string): Mark[] {
  const marks: Mark[] = [];

  // 1. Wiki Images: ![[ImageName.png]]
  const wikiImageRe = /!\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = wikiImageRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const imgPath = m[1];
    const resolvedUrl = resolveUrl(imgPath, workspacePath);
    marks.push({
      from: s,
      to: e,
      dec: Decoration.replace({ widget: new ImageWidget(resolvedUrl, imgPath) })
    });
  }

  // 2. Images: ![Alt](URL)
  const imageRe = /!\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  while ((m = imageRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const resolvedUrl = resolveUrl(m[2], workspacePath);
    marks.push({
      from: s,
      to: e,
      dec: Decoration.replace({ widget: new ImageWidget(resolvedUrl, m[1]) })
    });
  }

  // 3. Links: [Text](URL) (ignore if preceded by !)
  const linkRe = /(?<!\!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  while ((m = linkRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const linkText = m[1];
    const url = m[2];

    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({
      from: s + 1,
      to: s + 1 + linkText.length,
      dec: Decoration.mark({
        class: "cm-prose-link",
        attributes: { href: url, target: "_blank", title: url }
      })
    });
    marks.push({ from: s + 1 + linkText.length, to: e, dec: REPLACE });
  }

  // 4. Inline Code: `code`
  const codeRe = /`([^`\n]+)`/g;
  while ((m = codeRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const codeText = m[1];

    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({
      from: s + 1,
      to: s + 1 + codeText.length,
      dec: Decoration.mark({ class: "cm-prose-inline-code" })
    });
    marks.push({ from: e - 1, to: e, dec: REPLACE });
  }

  // 5. Bold: **text**
  const boldRe = /\*\*([^*\n]+)\*\*/g;
  while ((m = boldRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 2, dec: REPLACE });
    marks.push({ from: s + 2, to: e - 2, dec: BOLD });
    marks.push({ from: e - 2, to: e, dec: REPLACE });
  }

  // 6. Italic: *text*
  const italicStarRe = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  while ((m = italicStarRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({ from: s + 1, to: e - 1, dec: ITALIC });
    marks.push({ from: e - 1, to: e, dec: REPLACE });
  }

  // 7. Italic: _text_
  const italicUnderRe = /(?<!_)_([^_\n]+)_(?!_)/g;
  while ((m = italicUnderRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({ from: s + 1, to: e - 1, dec: ITALIC });
    marks.push({ from: e - 1, to: e, dec: REPLACE });
  }

  // 8. Plain URLs: https://www.sigmajs.org/ (ignore if preceded by '(' or '[' or '"')
  const plainUrlRe = /(?<![\(\["])(https?:\/\/[^\s\n\)]+)/g;
  while ((m = plainUrlRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const url = m[1];
    marks.push({
      from: s,
      to: e,
      dec: Decoration.mark({
        class: "cm-prose-link",
        attributes: { href: url, target: "_blank", title: url }
      })
    });
  }

  // 9. Strike Through: ~~text~~
  const strikeRe = /~~([^~\n]+)~~/g;
  while ((m = strikeRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 2, dec: REPLACE });
    marks.push({
      from: s + 2,
      to: e - 2,
      dec: Decoration.mark({ class: "cm-prose-strike" })
    });
    marks.push({ from: e - 2, to: e, dec: REPLACE });
  }

  // Sort and filter out overlapping ranges to prevent CodeMirror RangeSetBuilder crashes
  marks.sort((a, b) => a.from - b.from || a.to - b.to);

  const nonOverlapping: Mark[] = [];
  let lastEnd = -1;
  for (const mark of marks) {
    if (mark.from >= lastEnd) {
      nonOverlapping.push(mark);
      lastEnd = mark.to;
    }
  }

  return nonOverlapping;
}

// --- Main builder ---

function buildDecorations(view: EditorView, workspacePath: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Document scan to pre-calculate block levels (Code blocks and Tables)
  const doc = view.state.doc;
  const codeBlockLines = new Set<number>();
  const codeDelimiterLines = new Set<number>();
  const codeFirstLines = new Set<number>();
  const codeLastLines = new Set<number>();
  const tableLines = new Set<number>();
  const tableSeparatorLines = new Set<number>();

  let inCode = false;
  let codeStartLine = -1;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const trimmed = text.trim();
    if (trimmed.startsWith("```")) {
      if (!inCode) {
        inCode = true;
        codeStartLine = i + 1;
      } else {
        inCode = false;
        codeLastLines.add(i - 1);
      }
      codeDelimiterLines.add(i);
      codeBlockLines.add(i);
    } else if (inCode) {
      codeBlockLines.add(i);
      if (i === codeStartLine) {
        codeFirstLines.add(i);
      }
    } else {
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        if (/^\s*\|?\s*(:?-+:?\s*\|?\s*)+$/.test(trimmed)) {
          tableSeparatorLines.add(i);
        } else {
          tableLines.add(i);
        }
      }
    }
  }

  // Lines containing selection head — show raw markdown on these
  const cursorLines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const from = view.state.doc.lineAt(range.from).number;
    const to = view.state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) cursorLines.add(n);
  }

  for (const { from, to } of view.visibleRanges) {
    let pos = view.state.doc.lineAt(from).from;

    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const raw = cursorLines.has(line.number);

      // 1. Code Block Delimiter
      if (codeDelimiterLines.has(line.number)) {
        if (!raw) {
          builder.add(line.from, line.to, REPLACE);
        } else {
          builder.add(line.from, line.from, lineClass("cm-prose-code-delimiter"));
        }
        pos = line.to + 1;
        continue;
      }

      // 2. Inside Code Block
      if (codeBlockLines.has(line.number)) {
        let cls = "cm-prose-code-line";
        const attrs: Record<string, string> = {};
        if (codeFirstLines.has(line.number)) {
          cls += " first";
          const openingLineNum = line.number - 1;
          if (openingLineNum >= 1) {
            const openingText = view.state.doc.line(openingLineNum).text.trim();
            const lang = openingText.slice(3).trim();
            if (lang) {
              attrs["data-lang"] = lang.toUpperCase();
            }
          }
        }
        if (codeLastLines.has(line.number)) cls += " last";
        builder.add(line.from, line.from, lineClass(cls, attrs));
        pos = line.to + 1;
        continue;
      }

      // 3. Table Separator Line
      if (tableSeparatorLines.has(line.number)) {
        if (!raw) {
          builder.add(line.from, line.to, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // 4. Table Row Line
      if (tableLines.has(line.number)) {
        if (!raw) {
          const parts = text.split("|");
          const cells = parts.slice(1, parts.length - 1);
          const isHeader = tableSeparatorLines.has(line.number + 1);
          builder.add(
            line.from,
            line.to,
            Decoration.replace({ widget: new TableRowWidget(cells, isHeader) })
          );
        } else {
          builder.add(line.from, line.from, lineClass("cm-prose-table-line-raw"));
        }
        pos = line.to + 1;
        continue;
      }

      // Scene break: --- alone on the line
      if (!raw && /^\s*---\s*$/.test(text)) {
        builder.add(
          line.from,
          line.to,
          Decoration.replace({ widget: new SceneBreakWidget() })
        );
        pos = line.to + 1;
        continue;
      }

      // Heading 4: #### …
      const h4 = /^#### (.*)/.exec(text);
      if (h4) {
        builder.add(line.from, line.from, lineClass("cm-prose-h4"));
        if (!raw) {
          builder.add(line.from, line.from + 5, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Heading 3: ### …
      const h3 = /^### (.*)/.exec(text);
      if (h3) {
        builder.add(line.from, line.from, lineClass("cm-prose-h3"));
        if (!raw) {
          builder.add(line.from, line.from + 4, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Heading 2: ## …
      const h2 = /^## (.*)/.exec(text);
      if (h2) {
        builder.add(line.from, line.from, lineClass("cm-prose-h2"));
        if (!raw) {
          builder.add(line.from, line.from + 3, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Heading 1: # …
      const h1 = /^# (.*)/.exec(text);
      if (h1) {
        builder.add(line.from, line.from, lineClass("cm-prose-h1"));
        if (!raw) {
          builder.add(line.from, line.from + 2, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Bullet Lists: - item or * item
      const bulletMatch = /^\s*([-*+])\s+(.*)/.exec(text);
      if (bulletMatch) {
        builder.add(line.from, line.from, lineClass("cm-prose-list-item"));
        if (!raw) {
          const markerStart = line.from + text.indexOf(bulletMatch[1]);
          builder.add(
            markerStart,
            markerStart + 2,
            Decoration.replace({ widget: new BulletWidget() })
          );
        }
      }

      // Numbered Lists: 1. item
      const numberMatch = /^\s*(\d+\.)\s+(.*)/.exec(text);
      if (numberMatch) {
        builder.add(line.from, line.from, lineClass("cm-prose-list-item number"));
      }

      // Inline bold / italic / links / inline-code / images / wiki-images
      if (!raw && text.length > 0) {
        for (const { from: f, to: t, dec } of collectInlineMarks(line.from, text, workspacePath)) {
          builder.add(f, t, dec);
        }
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

// --- Plugin export ---

export const prosePreviewPlugin = (workspacePath: string) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, workspacePath);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view, workspacePath);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
