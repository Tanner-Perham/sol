# ☀️ Sol

Sol is a fast, keyboard-driven, and Vim-first markdown editor built for local workspaces. Engineered as a native desktop application using **Tauri**, **React**, and **TypeScript**, Sol combines the power of **CodeMirror 6** with an inline prose preview, multi-pane splits, and deep Vim integration.

---

## ✨ Key Features

- **⌨️ Vim-First Modal Editing**
  - Full support for Vim modal editing (Normal, Insert, Visual, Visual Block modes) powered by CodeMirror Vim.
  - Custom Ex commands support:
    - `:w` or `:write` to save changes.
    - `:q` or `:quit` to close the active tab/pane.
    - `:qa` or `:qall` to close all tabs.

- **📖 Inline Prose Preview**
  - A clean WYSIWYG-style editor that automatically hides markdown syntax characters and renders formatted text, headers (H1–H4), checklists, strike-through, inline code blocks, tables, images, and horizontal lines directly inside the editor when your cursor is not on that line.

- **🔗 wiki Note Links & Images**
  - Supports wiki links (`[[Note Name]]` or `[[Note Name|Alias]]`) to quickly navigate between local notes.
  - Automatically creates a new file if a linked note doesn't exist, and styles broken links distinctively.
  - Supports embedding local assets and wiki-style images: `![[Image.png]]`.

- **🗂️ Split Panes & Multi-Tab Editing**
  - Split your workspace vertically (`Ctrl+A` then `\`) or horizontally (`Ctrl+A` then `-`) to view multiple files simultaneously.
  - Easily navigate between panes using prefix shortcuts or directly using `Ctrl+h/j/k/l`.
  - Multi-tab file organization per pane, allowing you to cycle and manage open files easily.

- **🖱️ Mouse-Free Sidebar Explorer**
  - Fully keyboard-driven workspace directory listing.
  - Navigate using standard Vim motion keys (`j`/`k` to move selection, `h`/`l` to fold/unfold folders, `Enter`/`Space` to open, `gg`/`G` to jump to top/bottom).
  - Supports numeric counts for jumping multiple items at once (e.g., `5j`).

- **🎨 Themes & Customizations**
  - Beautiful pre-configured editor and UI themes:
    - *Sol Dark* (Default), *Nord*, *Monokai*, *Forest*, *Sepia*, *Light*, and *Lego*.
  - Configurable settings including:
    - Font Family (Sans, Serif, Mono)
    - Font Size and Line Height
    - Line Wrapping
    - Hidden files visibility toggling
    - Custom hotkeys mapping

- **⚡ Lightweight Rust Core**
  - Leverages a Tauri backend written in Rust.
  - Secure, native desktop experience with local-first file read/writes.
  - Automatic workspace file changes detection using recursive file watching (`notify`).

---

## 🚀 Quick Start

### Prerequisites

Ensure you have the following installed on your system:
- [Node.js](https://nodejs.org/) (Frontend compilation)
- [Rust](https://www.rust-lang.org/) (Tauri core compiler)
- A standard build utility (`make`)

### Setup and Development

We use a root `Makefile` to simplify common build, test, and formatting tasks.

1. **Install dependencies:**
   ```bash
   make install
   ```

2. **Start the development server (Frontend + Rust Backend):**
   ```bash
   make dev
   ```

3. **Start the frontend server only:**
   ```bash
   make dev-frontend
   ```

4. **Build the production executable:**
   ```bash
   make build
   ```

---

## ⌨️ Keyboard Shortcuts Reference

### Global Action Keybindings

| Action | Shortcut | Vim Ex Command |
|---|---|---|
| **Save Document** | `Ctrl + S` / `Cmd + S` | `:w`, `:write` |
| **Toggle Live Preview** | `Ctrl + P` / `Cmd + P` | |
| **Toggle Sidebar** | `Ctrl + E` / `Cmd + E` or `Ctrl + \` | |
| **Toggle Sidebar/Editor Focus** | `Tab` | |
| **Pane Prefix Key** | `Ctrl + A` | |

### Multi-Pane Split Controls (Triggered after Prefix `Ctrl + A`)

| Action | Shortcut |
|---|---|
| **Split Vertically** | `\` |
| **Split Horizontally** | `-` |
| **Close Active Pane** | `x` |
| **Move Focus Direct** *(No prefix)* | `Ctrl + h` / `j` / `k` / `l` |

### Tab Management

| Action | Shortcut | Vim Ex Command |
|---|---|---|
| **Select Tab (1 to 9)** | `Alt + [1-9]` | |
| **Cycle Tabs** | `Alt + H` / `L` or `Alt + Left` / `Right` | |
| **Close Active Tab** | `Alt + W` | `:q`, `:quit` |

### Sidebar Vim Navigation (Focused Component: Sidebar)

| Motion / Key | Action |
|---|---|
| `j` / `ArrowDown` | Move selection down |
| `k` / `ArrowUp` | Move selection up |
| `h` / `ArrowLeft` | Collapse folder or navigate to parent directory |
| `l` / `ArrowRight` | Expand folder or open file |
| `Enter` / `Space` | Toggle folder fold state or open selected file |
| `gg` | Go to the first file/folder |
| `G` | Go to the last file/folder |
| `[count]j` / `[count]k` | Move down/up by `[count]` items (e.g. `5j`) |

---

## 🛠️ Makefile Targets

| Target | Description |
|---|---|
| `make help` | Show usage details and all available targets |
| `make install` | Install frontend Node dependencies |
| `make dev` | Start Tauri dev environment (Frontend + Rust Backend) |
| `make dev-frontend` | Start Vite dev server for frontend only |
| `make build` | Build the production Tauri application bundle |
| `make build-frontend`| Build only the Vite frontend assets |
| `make test` | Run Rust tests and TypeScript type checks |
| `make test-rust` | Run Rust backend unit tests |
| `make lint` | Run clippy lint check and compiler type checks |
| `make format` | Automatically format Rust code |
| `make clean` | Remove build folders and clean cargo target outputs |

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](file:///home/grumblyghost/Projects/sol/LICENSE) for more details.
