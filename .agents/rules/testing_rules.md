# Rust Testing Rule

This rule ensures that all tests in the workspace are run through the provided Makefile commands, which handle necessary setup and environment variables.

- **DO NOT** run `cargo test` directly in the `src-tauri` directory.
- **ALWAYS** use `make test` (runs both Rust tests and frontend type checks) or `make test-rust` (runs only Rust unit tests) from the workspace root.
