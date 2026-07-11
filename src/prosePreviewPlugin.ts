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
import { getCM } from "@replit/codemirror-vim";
import { syntaxTree } from "@codemirror/language";

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

class EmptyLineSpacerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-empty-line-spacer";
    span.textContent = "\u00a0";
    return span;
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
  eq(other: ImageWidget): boolean {
    return this.url === other.url && this.alt === other.alt;
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
  eq(other: TableRowWidget): boolean {
    if (this.isHeader !== other.isHeader) return false;
    if (this.cells.length !== other.cells.length) return false;
    return this.cells.every((cell, i) => cell === other.cells[i]);
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

function rangeIntersectsSelection(from: number, to: number, selection: any): boolean {
  if (!selection) return false;
  for (const range of selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

function collectWikiMarks(
  lineFrom: number,
  text: string,
  workspacePath: string,
  selection: any,
  isLineRaw: boolean,
  markdownFiles: Set<string>
): Mark[] {
  const marks: Mark[] = [];
  let m: RegExpExecArray | null;

  // 1. Wiki Note Links: [[xyz]] or [[xyz|alias]] (ignore if preceded by !)
  const wikiLinkRe = /(?<!\!)\[\[([^\]\n]+)\]\]/g;
  while ((m = wikiLinkRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    const targetRaw = m[1];

    const parts = targetRaw.split("|");
    const linkTarget = parts[0].trim();
    const displayText = parts.length > 1 ? parts[1].trim() : linkTarget;

    const isCursorInside = isLineRaw && rangeIntersectsSelection(s + 2, e - 2, selection);

    if (!isCursorInside) {
      marks.push({ from: s, to: s + 2, dec: REPLACE });
    }

    if (!isCursorInside && parts.length > 1) {
      const aliasOffset = targetRaw.indexOf("|");
      marks.push({ from: s + 2, to: s + 2 + aliasOffset + 1, dec: REPLACE });
    }

    const cleanName = linkTarget.split("#")[0].trim();
    const isLocalHeader = cleanName === "";
    const targetFileName = (cleanName.toLowerCase().endsWith(".md") ? cleanName : `${cleanName}.md`).toLowerCase();
    const exists = isLocalHeader || markdownFiles.has(targetFileName);

    const linkClassStr = exists
      ? "cm-prose-link cm-prose-note-link"
      : "cm-prose-link cm-prose-note-link broken";

    const displayStart = parts.length > 1 ? s + 2 + targetRaw.indexOf("|") + 1 : s + 2;
    marks.push({
      from: displayStart,
      to: displayStart + displayText.length,
      dec: Decoration.mark({
        class: linkClassStr,
        attributes: { "data-note-link": linkTarget, title: exists ? `Open ${linkTarget}` : `Create ${cleanName}.md` }
      })
    });

    if (!isCursorInside) {
      marks.push({ from: displayStart + displayText.length, to: e, dec: REPLACE });
    }
  }

  // 2. Wiki Images: ![[ImageName.png]]
  if (!isLineRaw) {
    const wikiImageRe = /!\[\[([^\]\n]+)\]\]/g;
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
  }

  return marks;
}

// --- Main builder ---

interface DecSpec {
  from: number;
  to: number;
  dec: Decoration;
  category: number; // 1: Line, 2: Replace, 3: Mark
}

function buildDecorations(view: EditorView, workspacePath: string, markdownFiles: Set<string>): DecorationSet {
  const state = view.state;
  const tree = syntaxTree(state);
  const lowercaseFiles = new Set(Array.from(markdownFiles).map((f) => f.toLowerCase()));

  // Lines containing selection head — show raw markdown on these
  const cursorLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = state.doc.lineAt(range.from).number;
    const to = state.doc.lineAt(range.to).number;
    for (let n = from; n <= to; n++) cursorLines.add(n);
  }

  // Also show raw markdown for lines in visual block selection
  const cm = getCM(view);
  const vimState = cm?.state?.vim;
  if (vimState?.visualBlock && vimState?.sel) {
    const anchor = vimState.sel.anchor;
    const head = vimState.sel.head;
    const startLine = Math.min(anchor.line, head.line) + 1;
    const endLine = Math.max(anchor.line, head.line) + 1;
    for (let n = startLine; n <= endLine; n++) {
      cursorLines.add(n);
    }
  }

  const collected: DecSpec[] = [];

  // Iterate over visible ranges for maximum performance
  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    tree.iterate({
      from: rangeFrom,
      to: rangeTo,
      enter(nodeRef) {
        const node = nodeRef.node;
        const from = node.from;
        const to = node.to;
        const name = node.name;

        // Skip document root node
        if (name === "Document") return;

        // Check if node intersects cursor/raw lines
        const nodeStartLine = state.doc.lineAt(from).number;
        const nodeEndLine = state.doc.lineAt(to).number;
        let isRaw = false;
        for (let n = nodeStartLine; n <= nodeEndLine; n++) {
          if (cursorLines.has(n)) {
            isRaw = true;
            break;
          }
        }

        // 1. Headings
        if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
          let level = 1;
          const levelMatch = /Heading(\d)/.exec(name);
          if (levelMatch) {
            level = parseInt(levelMatch[1], 10);
          }
          const lineStart = state.doc.lineAt(from).from;
          collected.push({ from: lineStart, to: lineStart, dec: lineClass(`cm-prose-h${level}`), category: 1 });

          if (!isRaw && name.startsWith("ATXHeading")) {
            // Find HeaderMark (the "#" signs) and hide it along with the space
            let firstChild = node.firstChild;
            if (firstChild && firstChild.name === "HeaderMark") {
              collected.push({ from: firstChild.from, to: Math.min(firstChild.to + 1, to), dec: REPLACE, category: 2 });
            }
          }
        }

        // 2. Fenced Code Blocks
        else if (name === "FencedCode") {
          const startLineNum = state.doc.lineAt(from).number;
          const endLineNum = state.doc.lineAt(to).number;

          // Delimiter lines
          const startLine = state.doc.line(startLineNum);
          const endLine = state.doc.line(endLineNum);

          if (!isRaw) {
            collected.push({ from: startLine.from, to: startLine.to, dec: REPLACE, category: 2 });
            collected.push({ from: endLine.from, to: endLine.to, dec: REPLACE, category: 2 });
          } else {
            collected.push({ from: startLine.from, to: startLine.from, dec: lineClass("cm-prose-code-delimiter"), category: 1 });
            collected.push({ from: endLine.from, to: endLine.from, dec: lineClass("cm-prose-code-delimiter"), category: 1 });
          }

          // Content lines in-between
          let lang = "";
          let firstChild = node.firstChild;
          while (firstChild) {
            if (firstChild.name === "CodeInfo") {
              lang = state.doc.sliceString(firstChild.from, firstChild.to).trim();
              break;
            }
            firstChild = firstChild.nextSibling;
          }

          for (let l = startLineNum + 1; l < endLineNum; l++) {
            const line = state.doc.line(l);
            let cls = "cm-prose-code-line";
            const attrs: Record<string, string> = {};
            if (l === startLineNum + 1) {
              cls += " first";
              if (lang) {
                attrs["data-lang"] = lang.toUpperCase();
              }
            }
            if (l === endLineNum - 1) cls += " last";

            collected.push({ from: line.from, to: line.from, dec: lineClass(cls, attrs), category: 1 });

            if (line.text.length === 0) {
              collected.push({
                from: line.from,
                to: line.from,
                dec: Decoration.widget({ widget: new EmptyLineSpacerWidget(), side: 1 }),
                category: 2
              });
            }
          }
        }

        // 3. Lists
        else if (name === "ListItem") {
          const parentType = node.parent?.name;
          const isOrdered = parentType === "OrderedList";
          const lineStart = state.doc.lineAt(from).from;
          collected.push({
            from: lineStart,
            to: lineStart,
            dec: lineClass(isOrdered ? "cm-prose-list-item number" : "cm-prose-list-item"),
            category: 1
          });

          if (!isOrdered && !isRaw) {
            let firstChild = node.firstChild;
            while (firstChild) {
              if (firstChild.name === "ListMarker") {
                collected.push({
                  from: firstChild.from,
                  to: firstChild.to,
                  dec: Decoration.replace({ widget: new BulletWidget() }),
                  category: 2
                });
                break;
              }
              firstChild = firstChild.nextSibling;
            }
          }
        }

        // 4. Tables
        else if (name === "Table") {
          // Handled via child rows
        } else if (name === "TableDelim") {
          if (!isRaw) {
            collected.push({ from: from, to: to, dec: REPLACE, category: 2 });
          }
        } else if (name === "TableRow" || name === "TableHeader") {
          if (!isRaw) {
            const text = state.doc.sliceString(from, to);
            const parts = text.split("|");
            // Check for leading/trailing pipe
            const startIdx = text.startsWith("|") ? 1 : 0;
            const endIdx = text.endsWith("|") ? parts.length - 1 : parts.length;
            const cells = parts.slice(startIdx, endIdx);
            const isHeader = name === "TableHeader";
            collected.push({
              from: from,
              to: to,
              dec: Decoration.replace({ widget: new TableRowWidget(cells, isHeader) }),
              category: 2
            });
          } else {
            collected.push({ from: from, to: from, dec: lineClass("cm-prose-table-line-raw"), category: 1 });
          }
        }

        // 5. Horizontal Rule
        else if (name === "HorizontalRule") {
          if (!isRaw) {
            collected.push({
              from: from,
              to: to,
              dec: Decoration.replace({ widget: new SceneBreakWidget() }),
              category: 2
            });
          }
        }

        // 6. Inline Strong (Bold)
        else if (name === "StrongEmphasis") {
          let markerLen = 2;
          let firstChild = node.firstChild;
          if (firstChild && firstChild.name === "EmphasisMark") {
            markerLen = firstChild.to - firstChild.from;
          }
          if (!isRaw) {
            collected.push({ from: from, to: from + markerLen, dec: REPLACE, category: 2 });
            collected.push({ from: to - markerLen, to: to, dec: REPLACE, category: 2 });
          }
          collected.push({ from: from + markerLen, to: to - markerLen, dec: BOLD, category: 3 });
        }

        // 7. Inline Emphasis (Italic)
        else if (name === "Emphasis") {
          let markerLen = 1;
          let firstChild = node.firstChild;
          if (firstChild && firstChild.name === "EmphasisMark") {
            markerLen = firstChild.to - firstChild.from;
          }
          if (!isRaw) {
            collected.push({ from: from, to: from + markerLen, dec: REPLACE, category: 2 });
            collected.push({ from: to - markerLen, to: to, dec: REPLACE, category: 2 });
          }
          collected.push({ from: from + markerLen, to: to - markerLen, dec: ITALIC, category: 3 });
        }

        // 8. Inline Code (Code Span)
        else if (name === "InlineCode") {
          let markerLen = 1;
          let firstChild = node.firstChild;
          if (firstChild && firstChild.name === "CodeMark") {
            markerLen = firstChild.to - firstChild.from;
          }
          if (!isRaw) {
            collected.push({ from: from, to: from + markerLen, dec: REPLACE, category: 2 });
            collected.push({ from: to - markerLen, to: to, dec: REPLACE, category: 2 });
          }
          collected.push({
            from: from + markerLen,
            to: to - markerLen,
            dec: Decoration.mark({ class: "cm-prose-inline-code" }),
            category: 3
          });
        }

        // 9. Inline Strikethrough
        else if (name === "Strikethrough") {
          let markerLen = 2;
          let firstChild = node.firstChild;
          if (firstChild && firstChild.name === "StrikethroughMark") {
            markerLen = firstChild.to - firstChild.from;
          }
          if (!isRaw) {
            collected.push({ from: from, to: from + markerLen, dec: REPLACE, category: 2 });
            collected.push({ from: to - markerLen, to: to, dec: REPLACE, category: 2 });
          }
          collected.push({
            from: from + markerLen,
            to: to - markerLen,
            dec: Decoration.mark({ class: "cm-prose-strike" }),
            category: 3
          });
        }

        // 10. Links and Images
        else if (name === "Link") {
          let titleNode = null;
          let targetNode = null;
          let child = node.firstChild;
          while (child) {
            if (child.name === "LinkTitle") titleNode = child;
            if (child.name === "LinkTarget") targetNode = child;
            child = child.nextSibling;
          }

          if (titleNode && targetNode) {
            const url = state.doc.sliceString(targetNode.from, targetNode.to);
            if (!isRaw) {
              collected.push({ from: from, to: titleNode.from, dec: REPLACE, category: 2 });
              collected.push({ from: titleNode.to, to: to, dec: REPLACE, category: 2 });
            }
            collected.push({
              from: titleNode.from,
              to: titleNode.to,
              dec: Decoration.mark({
                class: "cm-prose-link",
                attributes: { href: url, target: "_blank", title: url }
              }),
              category: 3
            });
          }
        }

        else if (name === "Image") {
          let titleNode = null;
          let targetNode = null;
          let child = node.firstChild;
          while (child) {
            if (child.name === "LinkTitle") titleNode = child;
            if (child.name === "LinkTarget") targetNode = child;
            child = child.nextSibling;
          }

          if (targetNode && !isRaw) {
            const url = state.doc.sliceString(targetNode.from, targetNode.to);
            const alt = titleNode ? state.doc.sliceString(titleNode.from, titleNode.to) : "";
            const resolvedUrl = resolveUrl(url, workspacePath);
            collected.push({
              from: from,
              to: to,
              dec: Decoration.replace({ widget: new ImageWidget(resolvedUrl, alt) }),
              category: 2
            });
          }
        }

        // 11. Custom Wiki Link & Wiki Image scan on plain text / paragraph nodes
        else if (name === "Paragraph" || name === "Text") {
          const text = state.doc.sliceString(from, to);
          if (text.includes("[[")) {
            const wikiMarks = collectWikiMarks(from, text, workspacePath, state.selection, isRaw, lowercaseFiles);
            for (const wm of wikiMarks) {
              // Add wiki links to collected
              const isReplace = wm.dec.spec.widget !== undefined || wm.dec.spec.destroy !== undefined; // replace decs
              collected.push({
                from: wm.from,
                to: wm.to,
                dec: wm.dec,
                category: isReplace ? 2 : 3
              });
            }
          }
        }
      }
    });
  }

  // Sort collected decorations to ensure valid RangeSetBuilder order:
  // 1. Position from ascending
  // 2. Class type category: Line (1) -> Replace (2) -> Mark (3)
  collected.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    return a.category - b.category;
  });

  const builder = new RangeSetBuilder<Decoration>();
  let lastReplaceEnd = -1;

  for (const item of collected) {
    if (item.category === 2) { // Replace
      if (item.from < lastReplaceEnd) {
        // Skip overlapping replacements to prevent crash
        continue;
      }
      lastReplaceEnd = item.to;
    }

    if (item.from > state.doc.length || item.to > state.doc.length) {
      continue;
    }

    // For line decorations, 'to' must be equal to 'from'
    const finalTo = item.category === 1 ? item.from : item.to;

    // Safety check to ensure we only insert in increasing order
    builder.add(item.from, finalTo, item.dec);
  }

  return builder.finish();
}

// --- Plugin export ---

export const prosePreviewPlugin = (workspacePath: string, markdownFiles: Set<string>) => ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, workspacePath, markdownFiles);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view, workspacePath, markdownFiles);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
