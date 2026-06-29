import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import DOMPurify from "dompurify";
import {EditorState} from "@codemirror/state";
import {EditorView, keymap} from "@codemirror/view";
import {defaultKeymap} from "@codemirror/commands";

function App() {

  const [displayContents, setDisplayContents] = useState("Hello World");

  async function display() {
    const html = await invoke<string>("display");
    const cleanHTML = DOMPurify.sanitize(html)
    setDisplayContents(
      cleanHTML
    );
  }

  const editorContainer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editorContainer.current) return;

    let startState = EditorState.create({
      doc: displayContents,
      extensions: [keymap.of(defaultKeymap)]
    });

    let view = new EditorView({
      state: startState,
      parent: editorContainer.current
    });

    return () => {
      view.destroy();
    };
  }, [displayContents]);

  return (
    <main className="container">
      <h1>SOL</h1>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          display();
        }}
      >
        <button type="submit">Display</button>
      </form>
      <div ref={editorContainer} className="editor-container" />
    </main>
  );
}

export default App;
