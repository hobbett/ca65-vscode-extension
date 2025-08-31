# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - 2025-08-31

### Added
- Initial beta release of the ca65 Language Server.
- Textmates syntax highlighting.
- Diagnostics (Errors, Warnings, Hints) powered by `ca65`.
- *Go to Definition* for labels, macros, and scopes.
- *Find All References* (workspace-wide).
- *Rename symbol across workspace*
- Hover Information for symbols, directives, and mnemonics.
- Autocompletion for all visible symbols in current translation unit.
- Autocompletion with auto-import/include for symbols defined/exported across the workspace.
- Call Hierarchy provider based on `jsr`/`jmp`
- Code Folding and sticky scroll for labels.
- Inlay hints for nameless labels.
- 6502 instruction reference page accessible from command palette (`shift-ctrl-p`)
