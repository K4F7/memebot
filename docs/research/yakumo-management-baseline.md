# Yakumo Management Baseline for MemeBot Plugins

Date: 2026-08-17

## Question

How should the standalone Koishi plugin monorepo adopt Yakumo without losing repository-specific build, test, and release guarantees?

## Finding

Yakumo is Koishi's workspace orchestration tool. Its package discovery builds on package-manager workspaces, so the existing `plugins/*` Yarn workspace remains a suitable package boundary. Koishi's official boilerplate uses `yakumo`, `yakumo-esbuild`, and `yakumo-tsc`, with `yakumo.yml` defining build and clean pipelines.

The official boilerplate is a baseline, not a drop-in replacement for this repository's verification. MemeBot plugins currently include Vite client builds and package-specific type-check steps, while the repository also has root tests, plugin-load checks, and release-tag validation. Those behaviors must be mapped and tested explicitly before removing the existing scripts.

## Recommended migration contract

- Keep `workspaces: ["plugins/*"]`; add more workspace globs only when matching directories actually exist.
- Introduce the official Yakumo core, TypeScript, and bundling extensions and a minimal `yakumo.yml` pipeline.
- Let Yakumo select and orchestrate plugin workspaces, but preserve Vite-based client builds wherever the package requires them.
- Preserve repository-level TypeScript test-project checking, Vitest, plugin-load checks, and local smoke checks until an equivalent Yakumo command is proven to cover them.
- Preserve independent plugin versions and the existing tag-to-package publish guard. Adopting `yakumo publish` is a separate release decision, not an automatic consequence of adopting Yakumo builds.
- Compare generated artifacts and run every affected plugin's tests before deleting old workspace scripts.

## Primary sources

- [Yakumo repository and extension overview](https://github.com/cordiverse/yakumo#readme)
- [Yakumo's own workspace scripts](https://github.com/cordiverse/yakumo/blob/main/package.json)
- [Koishi official boilerplate package.json](https://raw.githubusercontent.com/koishijs/boilerplate/master/package.json)
- [Koishi official boilerplate yakumo.yml](https://raw.githubusercontent.com/koishijs/boilerplate/master/yakumo.yml)

## Decision input

Yakumo can replace hand-written cross-workspace traversal, but the migration ticket must first create a command-by-command acceptance matrix. The safe endpoint is Yakumo-managed orchestration with explicit repository-level checks, not a blanket replacement of all current scripts by `yakumo build`.
