# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Development and Build Automation

A root `Makefile` is provided to run common development, testing, linting, formatting, and build tasks easily.

### Prerequisites

Make sure you have the following installed:
- [Node.js](https://nodejs.org/) (for the React frontend)
- [Rust](https://www.rust-lang.org/) (for the Tauri backend)
- standard build utilities like `make`

### Quick Start

1. **Install dependencies:**
   ```bash
   make install
   ```

2. **Start the development server:**
   ```bash
   make dev
   ```

### All Makefile Targets

| Target | Description | Command |
|---|---|---|
| `make help` | Show usage details and all available targets | Displays the help menu |
| `make install` | Install frontend Node dependencies | `npm install` |
| `make dev` | Start Tauri dev environment (Frontend + Rust Backend) | `npm run tauri dev` |
| `make dev-frontend` | Start Vite dev server for frontend only | `npm run dev` |
| `make build` | Build the production Tauri application bundle | `npm run tauri build` |
| `make build-frontend`| Build only the Vite frontend assets | `npm run build` |
| `make test` | Run Rust tests and TypeScript type checks | Runs Rust tests and frontend type checks |
| `make test-rust` | Run Rust backend unit tests | `cargo test ...` |
| `make lint` | Run clippy lint check and compiler type checks | Runs `cargo clippy` and `tsc --noEmit` |
| `make format` | Automatically format Rust code | `cargo fmt ...` |
| `make clean` | Remove build folders and clean cargo target outputs | Removes `dist/` and runs `cargo clean` |

