.PHONY: help install dev dev-frontend build build-frontend run test test-rust lint lint-rust lint-frontend format clean

# Default target when running just 'make'
.DEFAULT_GOAL := help

help:
	@echo "========================================================================"
	@echo "                      Sol Tauri App - Makefile                          "
	@echo "========================================================================"
	@echo "Usage: make [target]"
	@echo ""
	@echo "Development Targets:"
	@echo "  dev             Start the Tauri development server (frontend + Rust)"
	@echo "  dev-frontend    Start only the Vite frontend dev server"
	@echo ""
	@echo "Build & Release Targets:"
	@echo "  build           Build the Tauri application bundle (production release)"
	@echo "  build-frontend  Build only the Vite frontend assets"
	@echo "  run             Run the release build with WebKit workarounds"
	@echo ""
  	@echo "Test & Quality Targets:"
	@echo "  test            Run all checks and tests (Rust tests + frontend type check)"
	@echo "  test-rust       Run Rust unit tests"
	@echo "  lint            Run clippy lint checks on Rust and compiler checks on frontend"
	@echo "  lint-rust       Run cargo clippy on Rust code"
	@echo "  lint-frontend   Run type checks on frontend (tsc --noEmit)"
	@echo "  format          Auto-format Rust code (cargo fmt)"
	@echo ""
	@echo "Maintenance Targets:"
	@echo "  install         Install frontend node dependencies"
	@echo "  clean           Clean build directories (dist/ and cargo target/)"
	@echo "========================================================================"

install:
	npm install

dev:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev

dev-frontend:
	npm run dev

build:
	NO_STRIP=1 npm run tauri build

run:
	WEBKIT_DISABLE_DMABUF_RENDERER=1 ./src-tauri/target/release/sol

build-frontend:
	npm run build

test-rust:
	cargo test --manifest-path src-tauri/Cargo.toml

test: test-rust lint-frontend

lint-rust:
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings -A clippy::too_many_arguments

lint-frontend:
	npx tsc --noEmit

lint: lint-rust lint-frontend

format:
	cargo fmt --manifest-path src-tauri/Cargo.toml

clean:
	rm -rf dist/ dist-ssr/
	cargo clean --manifest-path src-tauri/Cargo.toml
