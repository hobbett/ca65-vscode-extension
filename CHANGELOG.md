# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.7] - 2025-09-14
- Fix auto-includes not showing if auto-import symbol is found first.
- Show URI in symbol table dump.

## [1.5.6] - 2025-09-13
- Fix `--feature line_continuations` in ca65 diagnostics

## [1.5.5] - 2025-09-12
- Add setting to enable `--feature line_continuations` for the ca65 diagnostics.
- Scan symbol references in continuation lines.

## [1.5.4] - 2025-09-12
- Fix auto-complete not working on last line
- Fix labels not being scanned on last line

## [1.5.3] - 2025-09-11
- Fix .global statements not counting towards symbol usage

## [1.5.2] - 2025-09-11
- Fix implicit import symbol resolution

## [1.5.1] - 2025-09-10
- Add setting for implicit imports

## [1.5.0] - 2025-09-10
- Sped up auto-complete by ~10x
- Fix auto-import/include uris not resolving to the shortest path

## [1.4.13] - 2025-09-10
- Cleaned up symbol table references (removed hex letters, char literals, comment contents)
- Add setting to toggle folding ranges

## [1.4.12] - 2025-09-09
- Fix issue where includes were not correctly resolved on initial scan, which lead to broken "Find all references"
- Add debug commands to dump the current symbol table, includes graph, and exports map.

## [1.4.11] - 2025-09-06
- Minor speedup

## [1.4.9] - 2025-09-06
- Speed up auto-completion
- Abort in-progress diagnostics when file changes

## [1.4.8] - 2025-09-06
- Fix detection of `file.associations`
- Add additional setting to declare extensions for use with other IDEs 

## [1.4.5] - 2025-09-05
- Fix end ranges of scopes closed at EOF

## [1.4.4] - 2025-09-05
- Add performance logger and debug dump command

## [1.4.3] - 2025-09-05
- Use workspace-relative paths for import hints

## [1.4.0] - 2025-09-05
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
