# ca65 Assembly for Visual Studio Code

Provides basic LSP-backed language support for **ca65** assembly files.

## Features

This extension provides a full-featured language server to make writing `ca65` assembly a modern and productive experience.

* **ca65-backed Diagnostics:**
    * Live validation by running `ca65` in the background and applying the error output to the corresponding lines in the editor.
* **Code Navigation:**
    * **Go to Definition:** Jump directly to the definition of any label, constant, macro, or scope. Works across local, included, and workspace-exported symbols.
    * **Find All References:** Quickly find all usages of a symbol across the entire workspace.
    * **Call Hierarchy:** See who calls a procedure/label (`Incoming Calls`) and who a procedure/label calls (`Outgoing Calls`).  by `jsr` and `jmp` mnemonics.
    * **Outline view:** Symbols defined in a file are displayed in the `OUTLINE` view in the side panel.
* **Code Intelligence:**
    * **Rich Hover Information:** Hover over any symbol, directive, or 6502 mnemonic to see its definition, documentation, and scope context.
    * **Autocompletion:** Get completion suggestions for all accessible symbols, including local, included, and imported labels and macros. If a label is exported somewhere else in the workspace but not yet imported, the autocompletion will also automatically add an `.import` or `.include` statement at the top of the file.
    * **Import tracing:** Import statements will have an inlay hint displaying the file the symbol is imported from.
    * **Anonymous label indexing:** Anonymous labels (declared with a single `:`) will be assigned a unique index value, which will be displayed next to the declaration as an inlay hint. The same index will display next to each relative reference to the label (i.e. with `:++`, `:--` etc) 
* **Editor Features:**
    * **Syntax Highlighting:** Basic TextMate grammar for ca65 syntax.
    * **Snippets:** Snippets for commonly used directives like `.proc` and `.macro`, which expand with their respective closing statements.
    * **Code Folding and sticky scroll:** Fold regions of code like `.proc`, `.scope`, `.struct`, and other blocks. The last folding region's starting line will display at the top of the screen as a sticky scroll anchor.
    * **Instruction reference page:** A list of 6502 instructions with basic descriptions is available via the `ca65: Show Instruction Reference` command in the command prompt (`ctrl+shift+p`)
    
## Known Limitations

* Diagnostics are mainly powered via `ca65`'s `stderr`, so they may be limited in detail, and they do not provide any diagnostics about the linking step.
* The LSP is agnostic to the actual build command your project uses, it assumes that all ca65 files are linked together for the purpose of import/export visibility.
* Macro expansion is entirely opaque to the LSP, so symbols/scopes/syntax that are affected by macro expansion will not be visible to the LSP.
* Symbols with multiple definitions will always resolve to the first definition in the same file.
* Symbol refs will always resolve to the symbol even if a macro is declared with the same name after it's declaration.
* Auto-completion in the operand will only suggest symbols -- it will not suggest `struct`s in a `.tag` or `.sizeof` command
* Anonymous structs are currently not handled to spec (the spec adds the members to an anonymous scope, but `ca65` actually adds them to the parent scope).

## Pre-requisites
You must provide the `ca65` in your system's `PATH` or set setting `ca65.executablePath` to the absolute path of your `ca65` executable.

## Installation

You can install this extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=hobbett.ca65-vscode-extension).

Alternatively, in VS Code, open the **Extensions** view (`Ctrl+Shift+X`), search for `ca65 Assembly`, and click **Install**.

## File detection

By default, `.s`, `.asm`, and `.inc` files are detected as `ca65` language.

If you wish to add more extensions to be included, simply add them to `files.associations` in settings.

e.g.
```
"files.associations": {
    "*.incs": "ca65",
    "*.a65": "ca65",
    "*.mycoolextension": "ca65"
}
```

## Other settings

Paths for `.include` and `.incbin` (i.e. what you would pass into `-I` and `--bin-include-dir` during the assembly step) may be specified by `ca65.includeDirs` and `ca65.binIncludeDirs` settings.

Please see the Settings gear icon in the installed extension to easily set this and other settings.

## Building a standalone LSP executable for other editors
You can build a standalone LSP executable via the following shell commands. The executable will be placed in `dist/bin/ca65-lsp-<platform>` 
```
npm run package-lsp:linux   # Linux
npm run package-lsp:win     # Windows
npm run package-lsp:macos   # MacOS
npm run package-lsp         # All Three
```
## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
