import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import DOMPurify from "dompurify";

function App() {
  const [displayContents, setDisplayContents] = useState("");

  async function display() {
    const html = await invoke<string>("display");
    setDisplayContents(DOMPurify.sanitize(html));
  }

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
      <div dangerouslySetInnerHTML={{ __html: displayContents}} />
    </main>
  );
}

export default App;
