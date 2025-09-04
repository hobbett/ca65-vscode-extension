# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2025-09-05
- Suppress autocompletion while typing an anonymous label reference

## [1.3.0] - 2025-09-04
- Add symbol unused diagnostics
- Support wildcard include paths
- Fix textmates syntax for # and @
- Remove empty line allowance between symbol def and doc comment for hover card

## [1.2.1] - 2025-09-02
- Update changelog

## [1.2.0] - 2025-09-02
- Added settings for toggling inlay hints for anonymous labels and "import from" hints.
- Fixed settings not being dynamically reloaded when changed.

## [1.1.0] - 2025-09-01
- Removed hard-coding of .s and .inc files in favor of dynamically using ca65-associated extensions. .s, .inc, and .asm will still be the defaults.
- Added setting to specify include and incbin dirs for link resolution and diagnostics.
- Added doc comment snippet ('doc') and auto-continuation.

## [1.0.0] - 2025-08-31

### Added
- Removed prelease versioning to prepare for VS Marketplace publishing.

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
