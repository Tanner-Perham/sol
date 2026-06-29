import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

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

// --- Cached decoration instances ---

const REPLACE = Decoration.replace({});
const BOLD = Decoration.mark({ class: "cm-prose-bold" });
const ITALIC = Decoration.mark({ class: "cm-prose-italic" });

function lineClass(cls: string) {
  return Decoration.line({ attributes: { class: cls } });
}

// --- Inline mark helpers ---

interface Mark {
  from: number;
  to: number;
  dec: Decoration;
}

function collectInlineMarks(lineFrom: number, text: string): Mark[] {
  const marks: Mark[] = [];

  // Bold: **text** (greedy prevention via [^*])
  const boldRe = /\*\*([^*\n]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 2, dec: REPLACE });
    marks.push({ from: s + 2, to: e - 2, dec: BOLD });
    marks.push({ from: e - 2, to: e, dec: REPLACE });
  }

  // Italic: *text* — must not be adjacent to another *
  const italicStarRe = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
  while ((m = italicStarRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({ from: s + 1, to: e - 1, dec: ITALIC });
    marks.push({ from: e - 1, to: e, dec: REPLACE });
  }

  // Italic: _text_
  const italicUnderRe = /(?<!_)_([^_\n]+)_(?!_)/g;
  while ((m = italicUnderRe.exec(text)) !== null) {
    const s = lineFrom + m.index;
    const e = s + m[0].length;
    marks.push({ from: s, to: s + 1, dec: REPLACE });
    marks.push({ from: s + 1, to: e - 1, dec: ITALIC });
    marks.push({ from: e - 1, to: e, dec: REPLACE });
  }

  // Sort ascending by from, then to (RangeSetBuilder requirement)
  marks.sort((a, b) => a.from - b.from || a.to - b.to);

  return marks;
}

// --- Main builder ---

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Lines that contain any selection head — show raw markdown on these
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
      const raw = cursorLines.has(line.number); // show raw on this line?

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

      // Heading 2: ## …
      const h2 = /^## (.*)/.exec(text);
      if (h2) {
        // Line class first (zero-length, same from)
        builder.add(line.from, line.from, lineClass("cm-prose-h2"));
        if (!raw) {
          // Hide "## " (3 chars)
          builder.add(line.from, line.from + 3, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Heading 1: # … (check after h2 to avoid false match)
      const h1 = /^# (.*)/.exec(text);
      if (h1) {
        builder.add(line.from, line.from, lineClass("cm-prose-h1"));
        if (!raw) {
          // Hide "# " (2 chars)
          builder.add(line.from, line.from + 2, REPLACE);
        }
        pos = line.to + 1;
        continue;
      }

      // Inline bold / italic
      if (!raw && text.length > 0) {
        for (const { from: f, to: t, dec } of collectInlineMarks(line.from, text)) {
          builder.add(f, t, dec);
        }
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

// --- Plugin export ---

export const prosePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
