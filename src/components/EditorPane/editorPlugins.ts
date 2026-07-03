import { RangeSetBuilder } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";

// Widget for visual block empty line indicator
export class VisualBlockEmptyWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-visual-block-empty-indicator";
    span.textContent = "\u00a0"; // non-breaking space
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export const customSelectionHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.getDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        this.decorations = this.getDecorations(update.view);
      }
    }

    getDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const cm = getCM(view);
      const vimState = cm?.state?.vim;
      const isVisualBlock = vimState?.visualBlock === true;

      // For visual block mode, we need to read directly from vim's selection state
      // because CodeMirror doesn't natively support block selections
      if (isVisualBlock && vimState?.sel) {
        const anchor = vimState.sel.anchor;
        const head = vimState.sel.head;

        // Calculate the block rectangle
        const startLineNum = Math.min(anchor.line, head.line) + 1; // vim uses 0-indexed
        const endLineNum = Math.max(anchor.line, head.line) + 1;
        const startCol = Math.min(anchor.ch, head.ch);
        const endCol = Math.max(anchor.ch, head.ch) + 1; // inclusive

        const blockMarkDec = Decoration.mark({ class: "cm-visual-block-selection" });

        // Create decorations for each line in the block
        const decorations: { from: number; to: number; dec: typeof blockMarkDec }[] = [];

        for (let lineNum = startLineNum; lineNum <= endLineNum; lineNum++) {
          if (lineNum > view.state.doc.lines) continue;
          const line = view.state.doc.line(lineNum);
          const lineStartCol = Math.min(startCol, line.text.length);
          const lineEndCol = Math.min(endCol, line.text.length);

          if (lineStartCol < lineEndCol) {
            const from = line.from + lineStartCol;
            const to = line.from + lineEndCol;
            decorations.push({ from, to, dec: blockMarkDec });
          } else if (line.text.length === 0) {
            // Empty line - use a widget to show a visible indicator
            decorations.push({
              from: line.from,
              to: line.from,
              dec: Decoration.widget({
                widget: new VisualBlockEmptyWidget(),
                side: 1
              })
            });
          }
        }

        // Sort by position and add to builder
        decorations.sort((a, b) => a.from - b.from);
        for (const d of decorations) {
          if (d.from <= d.to) {
            builder.add(d.from, d.to, d.dec);
          }
        }

        return builder.finish();
      }

      // Regular selection handling (non-block mode)
      const ranges = view.state.selection.ranges;
      const hasSelection = ranges.some(r => !r.empty);
      if (!hasSelection) {
        return builder.finish();
      }

      const markDec = Decoration.mark({ class: "cm-custom-selection" });
      const emptyLineMarkDec = Decoration.mark({ class: "cm-custom-selected-empty-mark" });

      for (const range of ranges) {
        if (range.empty) continue;

        const startLine = view.state.doc.lineAt(range.from);
        const endLine = view.state.doc.lineAt(range.to);

        if (startLine.number === endLine.number) {
          builder.add(range.from, range.to, markDec);
        } else {
          for (let n = startLine.number; n <= endLine.number; n++) {
            const line = view.state.doc.line(n);
            if (line.text.length === 0) {
              builder.add(line.from, line.to, emptyLineMarkDec);
            } else {
              const from = n === startLine.number ? range.from : line.from;
              const to = n === endLine.number ? range.to : line.to;
              if (from < to) {
                builder.add(from, to, markDec);
              }
            }
          }
        }
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations
  }
);
