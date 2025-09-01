import {
    _Connection,
    TextDocuments,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    Range,
    TextEdit,
    SymbolKind as LSPSymbolKind,
    Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getDocumentSettings, includesGraph, symbolTables } from './server';
import { directiveData, mnemonicData } from './dataManager';
import { Export, Import, ImportKind, Macro, MacroKind, Scope, ScopeKind, Symbol, SymbolTable, SymbolTableEntity } from './symbolTable';
import { findPreviousCheapLocalBoundary, CHEAP_LOCAL_BOUNDARY_REGEX } from './cheapLocalLabelUtils';
import { IncludesGraph } from './includesGraph';
import { getLSPSymbolKind, resolveExport, resolveImport } from './symbolResolver';
import { findCanonicalIncludePath, getRelativePath } from './pathUtils';
import { Ca65Settings } from './settings';

const CHEAP_LOCAL_ITEM_PREFIX = 0;
const VISIBLE_ITEM_PREFIX = 1;
const MNEMONIC_ITEM_PREFIX = 2;
const DIRECTIVE_ITEM_PREFIX = 3;
const AUTO_INCLUDE_ITEM_PREFIX = 4;
const AUTO_IMPORT_ITEM_PREFIX = 5;

function getCompletionItemKind(kind: LSPSymbolKind): CompletionItemKind {
    switch (kind) {
        case LSPSymbolKind.File:
            return CompletionItemKind.File;
        case LSPSymbolKind.Module:
            return CompletionItemKind.Module;
        case LSPSymbolKind.Namespace:
        case LSPSymbolKind.Package:
        case LSPSymbolKind.Class:
            return CompletionItemKind.Class;
        case LSPSymbolKind.Method:
            return CompletionItemKind.Method;
        case LSPSymbolKind.Property:
            return CompletionItemKind.Property;
        case LSPSymbolKind.Field:
            return CompletionItemKind.Field;
        case LSPSymbolKind.Constructor:
            return CompletionItemKind.Constructor;
        case LSPSymbolKind.Enum:
            return CompletionItemKind.Enum;
        case LSPSymbolKind.Interface:
            return CompletionItemKind.Interface;
        case LSPSymbolKind.Function:
            return CompletionItemKind.Function;
        case LSPSymbolKind.Variable:
            return CompletionItemKind.Variable;
        case LSPSymbolKind.Constant:
            return CompletionItemKind.Constant;
        case LSPSymbolKind.String:
            return CompletionItemKind.Text;  // no direct mapping, fallback to Text
        case LSPSymbolKind.Number:
        case LSPSymbolKind.Boolean:
            return CompletionItemKind.Value; // no direct mapping, fallback
        case LSPSymbolKind.Array:
        case LSPSymbolKind.Object:
            return CompletionItemKind.Field;
        case LSPSymbolKind.Key:
            return CompletionItemKind.Text;
        case LSPSymbolKind.Null:
            return CompletionItemKind.Value;
        case LSPSymbolKind.EnumMember:
            return CompletionItemKind.EnumMember;
        case LSPSymbolKind.Struct:
            return CompletionItemKind.Struct;
        case LSPSymbolKind.Event:
            return CompletionItemKind.Event;
        case LSPSymbolKind.Operator:
            return CompletionItemKind.Operator;
        case LSPSymbolKind.TypeParameter:
            return CompletionItemKind.TypeParameter;
        default:
            return CompletionItemKind.Text; // fallback for unknown kinds
    }
}

function getCompletionItemDetail(entity: SymbolTableEntity): string | undefined {
    if (
        entity instanceof Macro
        || entity instanceof Symbol
        || entity instanceof Scope
        || entity instanceof Import
        || entity instanceof Export
    ) {
        return entity.kind
    }

    return undefined
}

function isAutoIncludable(uri: string, settings: Ca65Settings) {
    if (settings.autoIncludeExtensions) {
        for (const ext of settings.autoIncludeExtensions) {
            if (uri.endsWith(ext)) return true;
        }
    }
    return false;
}

function getCheapLocalLabelCompletions(
    document: TextDocument,
    position: Position,
    replacementRange: Range,
    currentWord: string
): CompletionItem[] {
    const items: CompletionItem[] = [];
    const cheapLocalDefRegex = /^\s*(@[a-zA-Z0-9_@]+):/;

    const startLine = findPreviousCheapLocalBoundary(document, position.line);
    let endLine = document.lineCount - 1;
    for (let i = startLine + 1; i < document.lineCount; i++) {
        const line = document.getText(Range.create(i, 0, i + 1, 0));
        if (CHEAP_LOCAL_BOUNDARY_REGEX.test(line)) {
            endLine = i - 1;
            break;
        }
    }

    for (let i = startLine + 1; i <= endLine; i++) {
        const lineText = document.getText(Range.create(i, 0, i + 1, 0));
        const match = lineText.match(cheapLocalDefRegex);
        if (match) {
            const labelName = match[1];
            const item: CompletionItem = {
                label: labelName,
                kind: CompletionItemKind.Reference,
                detail: 'cheap_local_label',
                textEdit: TextEdit.replace(replacementRange, labelName),
                sortText: CHEAP_LOCAL_ITEM_PREFIX + labelName.slice(1)
            };
            if (!currentWord.startsWith('@')) {
                item.filterText = labelName.substring(1);
            }
            items.push(item);
        }
    }
    return items;
}

/**
 * Resolves a directive alias to its root definition (guaranteed to be only 1 level deep).
 * @param key The directive key to resolve.
 * @param data The full directive data object.
 * @returns The resolved directive object, or null if not found.
 */
function resolveDirectiveAlias(key: string, data: typeof directiveData): { type: string; [key: string]: any } | null {
    let entry = data[key as keyof typeof data];

    // If the entry is a string, it's a single-level alias.
    if (typeof entry === 'string') {
        // Look up the real definition using the alias.
        entry = data[entry as keyof typeof data];
    }

    // After potentially one level of redirection, it should be an object.
    if (typeof entry === 'object' && entry !== null) {
        return entry;
    }

    return null;
}

export function initializeCompletionProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onCompletion(async (params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return [];
        }
        const settings = await getDocumentSettings(document.uri);
        const position = params.position;

        const lineToCursor = document.getText({ start: { line: params.position.line, character: 0 }, end: params.position });
        const fullLineUntrimmed = document.getText(Range.create(params.position.line, 0, params.position.line + 1, 0));
        
        const wordMatch = lineToCursor.match(/[a-zA-Z0-9_.:@]*$/);
        const currentWord = wordMatch ? wordMatch[0] : '';
        const replacementRange = Range.create(
            params.position.line,
            params.position.character - currentWord.length,
            params.position.line,
            params.position.character
        );

        // --- CONTEXT DETERMINATION ---
        const trimmedLine = fullLineUntrimmed.trim();
        const commandRegex = /^\s*(?:[a-zA-Z_@.][a-zA-Z0-9_@.]*:\s*)?([a-zA-Z_.]+)/;
        const lineMatch = trimmedLine.match(commandRegex);
        const commandOnLine = lineMatch ? lineMatch[1] : null;

        let isCommandContext = false;
        if (!commandOnLine) {
            // No command found yet, so we must be in command context.
            isCommandContext = true;
        } else {
            // A command exists; check cursor position relative to the command's end.
            const commandIndexInUntrimmedLine = fullLineUntrimmed.indexOf(commandOnLine);
            const commandEndPosition = commandIndexInUntrimmedLine + commandOnLine.length;
            
            // If the cursor is at or before the end of the command, it's command context.
            if (params.position.character <= commandEndPosition) {
                isCommandContext = true;
            }
        }

        if (isCommandContext) {
            // --- COMMAND CONTEXT: Suggest mnemonics, control commands, and macros ---
            const completionItems: CompletionItem[] = [];

            // 1. Add Mnemonics
            for (const key in mnemonicData) {
                const lowerCaseKey = key.toLowerCase();
                completionItems.push({
                    label: lowerCaseKey,
                    kind: CompletionItemKind.Keyword,
                    detail: 'Mnemonic',
                    textEdit: TextEdit.replace(replacementRange, key.toLowerCase()),
                    sortText: MNEMONIC_ITEM_PREFIX + lowerCaseKey
                });
            }

            // 2. Add Directives (Control Commands)
            for (const key in directiveData) {
                const directive = resolveDirectiveAlias(key, directiveData);
                if (directive && directive.type === 'Control command') {
                    const directiveName = `.${key.toLowerCase()}`;
                    completionItems.push({
                        label: directiveName,
                        kind: CompletionItemKind.Keyword,
                        detail: 'Control Command',
                        textEdit: TextEdit.replace(replacementRange, directiveName),
                        sortText: DIRECTIVE_ITEM_PREFIX + directiveName
                    });
                }
            }

            // 3. Add Macros
            completionItems.push(...await getCompletionMacros(document, symbolTables, settings));
            return completionItems;
        } else {
            // --- OPERAND CONTEXT: Suggest labels, constants, variables, and pseudo-functions/variables ---
            const completionItems: CompletionItem[] = [];

            // 1. Add Workspace Symbols (excluding command macros)
            const allSymbols = await getCompletionSymbols(
                document, position, symbolTables, includesGraph, settings
            );
            const operands = allSymbols.filter(item => !item.detail?.includes('macro'));
            completionItems.push(...operands);

            // 2. Add Cheap Local Labels
            completionItems.push(
                ...getCheapLocalLabelCompletions(document, params.position, replacementRange, currentWord)
            );

            // 3. Add Pseudo-functions and Pseudo-variables
            for (const key in directiveData) {
                const directive = resolveDirectiveAlias(key, directiveData);
                if (directive && (directive.type === 'Pseudo-function' || directive.type === 'Pseudo-variable')) {
                    const directiveName = `.${key.toLowerCase()}`;
                    const kind = directive.type === 'Pseudo-function' ? CompletionItemKind.Function : CompletionItemKind.Variable;
                    completionItems.push({
                        label: directiveName,
                        kind: kind,
                        detail: directive.type,
                        textEdit: TextEdit.replace(replacementRange, directiveName),
                        sortText: DIRECTIVE_ITEM_PREFIX + directiveName
                    });
                }
            }
            
            return completionItems;
        }
    });
}

async function getCompletionMacros(
    document: TextDocument,
    allSymbolTables: Map<string, SymbolTable>,
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const completionItems: CompletionItem[] = [];

    const seenUris: Set<string> = new Set();
        
    for (const dep of includesGraph.getTransitiveDependencies(document.uri)) {
        if (seenUris.has(dep)) continue;
        seenUris.add(dep);

        const symbolTable = allSymbolTables.get(dep);
        if (!symbolTable) continue;

        for (const macro of symbolTable.getAllMacros()) {
            if (macro.kind === MacroKind.Macro) {
                let label = macro.name;
                let kind = getCompletionItemKind(getLSPSymbolKind(macro));
                let detail = `${getCompletionItemDetail(macro)}`;

                completionItems.push({
                    label,
                    kind,
                    detail,
                    sortText: VISIBLE_ITEM_PREFIX + label
                });
            }
        }
    }

    // Find macros in files we can auto-include.
    for (const [otherUri, symbolTable] of allSymbolTables) {
        if (!isAutoIncludable(otherUri, settings)) continue;
        if (seenUris.has(otherUri)) continue;
        
            for (const macro of symbolTable.getAllMacros()) {
                if (macro.kind !== MacroKind.Macro) continue;

                let label = macro.name;
                let kind = getCompletionItemKind(getLSPSymbolKind(macro));
                let detail = `${getCompletionItemDetail(macro)}`;
                let canonicalPath = await findCanonicalIncludePath(document.uri, otherUri, settings.includeDirs);

                completionItems.push({
                    label,
                    kind,
                    detail,
                    labelDetails: {
                        description: `include ${canonicalPath}`
                    },
                    additionalTextEdits: [makeIncludeEdit(document, canonicalPath)],
                    sortText: AUTO_INCLUDE_ITEM_PREFIX + label
                });
            }
    }

    return Array.from(completionItems.values());
}

async function getCompletionSymbols(
    document: TextDocument,
    position: Position,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const symbolTable = allSymbolTables.get(document.uri);
    if (!symbolTable) return [];

    const currentScope = symbolTable.getScopeAtPosition(position);
    if (!currentScope) return [];

    const completionItems: CompletionItem[] = [];

    // Gather all locally visible symbols
    const includedUris: Set<string> = new Set();
    const seenImports: Set<string> = new Set();
    const visibleFqns: Set<string> = new Set();
    for (const depUri of includesGraph.getTransitiveDependencies(document.uri)) {
        includedUris.add(depUri);
        const symbolTable = allSymbolTables.get(depUri);
        if (!symbolTable) continue;

        for (const entity of symbolTable.getAllDefinedEntities()) {
            if (
                entity instanceof Macro && entity.kind === MacroKind.Define
                || entity instanceof Symbol
                || entity instanceof Scope && entity.kind === ScopeKind.Proc
            ) {
                visibleFqns.add(entity.getFullyQualifiedName());
                let label = currentScope.findRelativeName(entity);
                let kind = getCompletionItemKind(getLSPSymbolKind(entity));
                let detail = `${getCompletionItemDetail(entity)}`;

                const completionItem = {
                    label,
                    kind,
                    detail,
                    sortText: VISIBLE_ITEM_PREFIX + label
                };

                completionItems.push(completionItem);
            }
        }

        for (const importEntity of symbolTable.imports) {
            seenImports.add(importEntity.name);
            visibleFqns.add(importEntity.getFullyQualifiedName());

            let label = currentScope.findRelativeName(importEntity);
            let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
            let detail = `${getCompletionItemDetail(importEntity)}`;

            // Try to resolve it to a definition we can use for the details. Otherwise, treat
            // it as an opaque import, which may be the case if it is a header for a library
            // file.
            const resolvedImport =
                resolveImport(importEntity.name, allSymbolTables, includesGraph);
            if (resolvedImport) {
                // This may be a global that is acting as an export, which we should ignore.
                let isExportingGlobal = false;
                if (importEntity.kind === ImportKind.Global) {
                    for (const tuUri of includesGraph.getTranslationUnit(importEntity.kind)) {
                        if (importEntity.uri === tuUri) {
                            isExportingGlobal = true;
                            break;
                        }
                    }
                }
                if (isExportingGlobal) break;

                if (resolvedImport.uri === document.uri) continue;
                kind = getCompletionItemKind(getLSPSymbolKind(resolvedImport));
                detail = `${getCompletionItemDetail(resolvedImport)}`;
            }

            completionItems.push({
                label,
                kind,
                detail,
                sortText: VISIBLE_ITEM_PREFIX + label
            });
        }
    }

    // Search the workspace for symbols that we can auto-include or import
    for (const [uri, symbolTable] of allSymbolTables) {
        if (includedUris.has(uri)) continue;

        let canonicalPath = await findCanonicalIncludePath(document.uri, uri, settings.includeDirs);

        if (isAutoIncludable(uri, settings)) {
            // Suggest including .inc files that define a symbol
            for (const entity of symbolTable.getAllDefinedEntities()) {
                if (
                    entity instanceof Macro && entity.kind === MacroKind.Define
                    || entity instanceof Symbol
                    || entity instanceof Scope && entity.kind === ScopeKind.Proc
                ) {
                    if (visibleFqns.has(entity.getFullyQualifiedName())) continue;
                    let label = currentScope.findRelativeName(entity);
                    let kind = getCompletionItemKind(getLSPSymbolKind(entity));
                    let detail = `${getCompletionItemDetail(entity)}`;

                    completionItems.push({
                        label,
                        kind,
                        detail,
                        labelDetails: {
                            description: `include ${canonicalPath}`
                        },
                        additionalTextEdits: [makeIncludeEdit(document, canonicalPath)],
                        sortText: AUTO_INCLUDE_ITEM_PREFIX + label
                    });
                }
            }

            // Suggest including files that import symbols (i.e. headers)
            for (const importEntity of symbolTable.imports) {
                if (seenImports.has(importEntity.name)) continue;
                if (visibleFqns.has(importEntity.getFullyQualifiedName())) continue;

                let label = currentScope.findRelativeName(importEntity);
                let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
                let detail = `${getCompletionItemDetail(importEntity)}`;

                // Try to resolve it to a definition we can use for the details. Otherwise, treat
                // it as an opaque import, which may be the case if it is a header for a library
                // file.
                const resolvedExport =
                    resolveImport(importEntity.name, allSymbolTables, includesGraph);
                if (resolvedExport) {
                    kind = getCompletionItemKind(getLSPSymbolKind(resolvedExport));
                    detail = `${getCompletionItemDetail(resolvedExport)}`;
                }

                completionItems.push({
                    label,
                    kind,
                    detail,
                    labelDetails: {
                        description: `include ${canonicalPath}`
                    },
                    additionalTextEdits: [makeIncludeEdit(document, canonicalPath)],
                    sortText: AUTO_INCLUDE_ITEM_PREFIX + label
                });
            }
        }

        // Suggest importing symbols that are defined and exported
        for (const exportEntity of symbolTable.exports) {
            if (seenImports.has(exportEntity.name)) continue;
            seenImports.add(exportEntity.name);

            const resolvedExport = resolveExport(exportEntity, allSymbolTables, includesGraph);
            if (!resolvedExport) continue;

            let relativeUri = getRelativePath(document.uri, resolvedExport.uri);

            let label = currentScope.findRelativeName(exportEntity);
            let kind = getCompletionItemKind(getLSPSymbolKind(resolvedExport));
            let detail = `${getCompletionItemDetail(resolvedExport)}`;

            completionItems.push({
                label,
                kind,
                detail,
                labelDetails: {
                    description: `import from ${relativeUri}`
                },
                additionalTextEdits: [makeImportEdit(document, resolvedExport.name)],
                sortText: AUTO_IMPORT_ITEM_PREFIX + label
            });
        }
    }

    return Array.from(completionItems.values());
}

function makeIncludeEdit(
    document: TextDocument,
    includeUri: string
): TextEdit {
    let includeLine = `.include "${includeUri}"\n`;
    const lines = document.getText().split(/\r?\n/);

    let top = 0;

    // Skip contiguous comment block
    let foundComment;
    while (
        top < lines.length
        && lines[top].trim().startsWith(';')
    ) {
        foundComment = true;
        top++;
    }
    if (foundComment) top++;

    // Insert in order from the top of the block
    let insertAt = top;
    while (insertAt < lines.length && lines[insertAt].trim().toLowerCase().startsWith(".include")) {
        const existingPath = lines[insertAt]
            .trim()
            .slice(8) // remove ".include"
            .trim()
            .replace(/^"|"$/g, "");
        if (existingPath < includeUri) {
            insertAt++;
        } else {
            break;
        }
    }

    // Add empty space if we're at the end of the .include block and the line has content.
    const trimmedLine = lines[insertAt].trim().toLowerCase();
    if (trimmedLine && !trimmedLine.startsWith(".include")) includeLine = includeLine + `\n`;

    return TextEdit.insert(Position.create(insertAt, 0), includeLine);
}

function makeImportEdit(
    document: TextDocument,
    importSymbol: string
): TextEdit {
    let importLine = `.import ${importSymbol}\n`;
    const lines = document.getText().split(/\r?\n/);

    let top = 0;

    // Skip contiguous comment block
    let foundComment;
    while (
        top < lines.length
        && lines[top].trim().startsWith(';')
    ) {
        foundComment = true;
        top++;
    }
    if (foundComment && lines[top].trim().length === 0) top++;

    // Skip include block
    let foundInclude;
    while (
        top < lines.length
        && lines[top].trim().toLowerCase().startsWith('.include')
    ) {
        foundInclude = true;
        top++;
    }
    if (foundInclude && lines[top].trim().length === 0) top++;

    // Insert in order from the top of the block
    let insertAt = top;
    while (insertAt < lines.length && lines[insertAt].trim().toLowerCase().startsWith(".import")) {
        const existingImportSymbol = lines[insertAt]
            .trim()
            .slice(7) // remove ".import"
            .trim()
        if (existingImportSymbol < importSymbol) {
            insertAt++;
        } else {
            break;
        }
    }

    // Add empty space if we're at the end of the .import block and the line has content.
    const trimmedLine = lines[insertAt].trim().toLowerCase();
    if (trimmedLine && !trimmedLine.startsWith(".import")) importLine = importLine + `\n`;

    return TextEdit.insert(Position.create(insertAt, 0), importLine);
}
