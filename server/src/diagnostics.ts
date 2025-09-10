/**
 * This module handles running the ca65 compiler in the background to provide
 * live error, warning, and hint diagnostics.
 */

import {
    _Connection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    DiagnosticTag,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { execFile } from 'child_process';
import { URI } from 'vscode-uri';
import { getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import * as fs from 'fs/promises';
import * as os from "os";
import { promisify } from 'util';
import { Ca65Settings } from './settings';
import which from "which";
import { getWorkspaceFolderOfFile, getWorkspaceRelativePath, resolveWorkspaceRelativeDirs } from './pathUtils';
import { isEntityUsed } from './symbolResolver';

const execFileAsync = promisify(execFile);

const validationTimers: Map<string, NodeJS.Timeout> = new Map();
let connection: _Connection;
let documents: TextDocuments<TextDocument>;
let hasShownCa65NotFoundMessage = false;

let validationAbortController = new AbortController();

export function initializeDiagnostics(conn: _Connection, docs: TextDocuments<TextDocument>) {
    connection = conn;
    documents = docs;
}

/**
 * Finds unused symbols in a given file.
 * @param uri The URI of the document to check.
 * @param checkedUnusedSymbols A set to track symbols that have already been checked to avoid duplicate work.
 * @param existingDiags A list of existing diagnostics on the file to avoid creating conflicting hints.
 * @returns An array of diagnostics for unused symbols.
 */
async function findUnusedSymbolDiagnostics(uri: string, checkedUnusedSymbols: Set<string>, existingDiags: readonly Diagnostic[]): Promise<Diagnostic[]> {
    performanceMonitor.start("findUnusedSymbolDiagnostics");
    const lspDiagnostics: Diagnostic[] = [];
    const symbolTable = symbolTables.get(uri);
    if (!symbolTable) {
        performanceMonitor.stop("findUnusedSymbolDiagnostics");
        return [];
    }

    const definedEntities = symbolTable.getAllDefinedEntities();
    
    let i = 0;
    for (const entity of definedEntities) {
        // Await every 100 items in case we abort.
        if (i % 100 === 0) await Promise.resolve();
        i++;

        const fqn = entity.getFullyQualifiedName();
        if (entity.name.startsWith('<anon') || checkedUnusedSymbols.has(fqn)) {
            continue;
        }
        
        // Do not mark a symbol as unused if its definition line already has a diagnostic.
        const hasExistingDiagnostic = existingDiags.some(diag => diag.range.start.line === entity.definition.start.line);
        if (hasExistingDiagnostic) {
            continue;
        }

        if (!isEntityUsed(entity, symbolTables, includesGraph)) {
            const diagnostic: Diagnostic = {
                severity: DiagnosticSeverity.Hint,
                range: entity.definition,
                message: `Symbol '${entity.name}' is defined but never used.`,
                source: 'ca65-lsp',
                tags: [DiagnosticTag.Unnecessary]
            };
            lspDiagnostics.push(diagnostic);
        }
        checkedUnusedSymbols.add(fqn);
    }
    performanceMonitor.stop("findUnusedSymbolDiagnostics");
    return lspDiagnostics;
}

/**
 * Checks if a file exists and is executable.
 */
async function isExecutable(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Finds the ca65 executable by searching in order of priority.
 * @returns The full path to the executable, or null if not found.
 */
export async function findCa65Executable(settings: Ca65Settings): Promise<string | null> {
    if (settings.executablePath) {
        let expandedPath = settings.executablePath.replace(/^~/, os.homedir());
        expandedPath = path.resolve(expandedPath);
        if (await isExecutable(expandedPath)) {
            return expandedPath;
        }
    }
    try {
        const pathInSystem = await which('ca65');
        if (pathInSystem) return pathInSystem;
    } catch (e) {}

    return null;
}

/**
 * Gathers only the ca65 compiler diagnostics for a single translation unit.
 * @param textDocument The root document of the translation unit to validate.
 * @param signal AbortSignal for cancelling the operation
 * @returns A Map of URIs to their collected compiler diagnostics.
 */
async function getCompilerDiagnosticsForUnit(
    textDocument: TextDocument,
    signal: AbortSignal
): Promise<Map<string, Diagnostic[]>> {
    performanceMonitor.start("getCompilerDiagnosticsForUnit");
    const settings = await getDocumentSettings(textDocument.uri);
    if (signal.aborted) return new Map();
    const diagnosticsByUri = new Map<string, Diagnostic[]>();
    if (!settings.enableCa65StdErrDiagnostics) return diagnosticsByUri;

    const ca65Path = await findCa65Executable(settings);
    if (signal.aborted) return new Map();
    if (!ca65Path) {
        if (!hasShownCa65NotFoundMessage) {
            connection.window.showErrorMessage('ca65 executable not found. Please set "ca65.executablePath" or ensure it is in your PATH.');
            hasShownCa65NotFoundMessage = true;
        }
        performanceMonitor.stop("getCompilerDiagnosticsForUnit");
        return diagnosticsByUri;
    }

    const workspaceFolderUri = getWorkspaceFolderOfFile(textDocument.uri);
    const workspaceRoot = workspaceFolderUri ? URI.parse(workspaceFolderUri).fsPath : path.dirname(URI.parse(textDocument.uri).fsPath);
    
    const filePath = URI.parse(textDocument.uri).fsPath;
    const relativeFilePath = path.relative(workspaceRoot, filePath);

    const args = [relativeFilePath, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'];

    if (settings.implicitImports) args.push('--auto-import');

    for (const includeDir of resolveWorkspaceRelativeDirs(textDocument.uri, settings.includeDirs)) {
        args.push('-I', includeDir);
    }
    for (const binIncludeDir of resolveWorkspaceRelativeDirs(textDocument.uri, settings.binIncludeDirs)) {
        args.push('--bin-include-dir', binIncludeDir);
    }

    let stderr = '';
    try {
        const result = await execFileAsync(ca65Path, args, { cwd: workspaceRoot, signal });
        stderr = result.stderr;
    } catch (err: any) {
        if (err && err.stderr) stderr = err.stderr;
    }
    if (signal.aborted) return new Map();

    if (stderr) {
        const lines = stderr.split(/\r?\n/);
        const errorRegex = /^(.*?):(\d+):\s(Warning|Error):\s(.*)$/;
        const noteRegex = /^(.*?):(\d+):\sNote:\s(.*)$/;
        
        for (let i = 0; i < lines.length; i++) {
            if (signal.aborted) return new Map();
            const line = lines[i];
            const errorMatch = line.match(errorRegex);
            if (errorMatch) {
                const [_, fileName, lineNumStr, severityStr, message] = errorMatch;
                const errorFileUri = URI.file(path.resolve(workspaceRoot, fileName)).toString();
                const lineNumber = parseInt(lineNumStr, 10) - 1;

                if (!diagnosticsByUri.has(errorFileUri)) {
                    diagnosticsByUri.set(errorFileUri, []);
                }
                
                let diagnosticMessage = message;

                const diagnostic: Diagnostic = {
                    severity: severityStr === 'Error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                    range: Range.create(lineNumber, 0, lineNumber + 1, 0), // Default to full line
                    message: diagnosticMessage,
                    source: 'ca65',
                    relatedInformation: []
                };

                let errorDocument = documents.get(errorFileUri);
                if (!errorDocument) {
                    try {
                        const content = await fs.readFile(URI.parse(errorFileUri).fsPath, 'utf-8');
                        errorDocument = TextDocument.create(errorFileUri, 'ca65', 0, content);
                    } catch {}
                }

                if (errorDocument) {
                    const lineText = errorDocument.getText(Range.create(lineNumber, 0, lineNumber + 1, 0));
                    const lineWithoutComment = lineText.includes(';') ? lineText.substring(0, lineText.indexOf(';')) : lineText;
                    const trimmedLine = lineWithoutComment.trim();
                    const startChar = lineWithoutComment.indexOf(trimmedLine);
                    const endChar = startChar + trimmedLine.length;
                    diagnostic.range = Range.create(lineNumber, startChar, lineNumber, endChar);

                    const symbolMatch = message.match(/Symbol\s+‘(.*?)’/);
                    const foundTokenMatch = message.match(/found\s+‘(.*?)’/);

                    if (symbolMatch) {
                        const symbolName = symbolMatch[1];
                        const symbolIndex = lineText.indexOf(symbolName);
                        if (symbolIndex !== -1) {
                            diagnostic.range = Range.create(lineNumber, symbolIndex, lineNumber, symbolIndex + symbolName.length);
                        }
                    } else if (foundTokenMatch) {
                        const token = foundTokenMatch[1];
                        const tokenIndex = lineText.indexOf(token);
                        if (tokenIndex !== -1) {
                            diagnostic.range = Range.create(lineNumber, tokenIndex, lineNumber, tokenIndex + token.length);
                        }
                    }
                }

                const noteMatch = (i + 1 < lines.length) ? lines[i + 1].match(noteRegex) : null;
                if (noteMatch) {
                    const [_, noteFileName, noteLineNumStr, noteMessage] = noteMatch;
                    const noteFileUri = URI.file(path.resolve(workspaceRoot, noteFileName)).toString();
                    const noteLineNumber = parseInt(noteLineNumStr, 10) - 1;
                    diagnostic.relatedInformation?.push({
                        location: {
                            uri: noteFileUri,
                            range: Range.create(noteLineNumber, 0, noteLineNumber + 1, 0)
                        },
                        message: noteMessage
                    });
                    i++;
                }
                diagnosticsByUri.get(errorFileUri)!.push(diagnostic);
            }
        }
    }
    performanceMonitor.stop("getCompilerDiagnosticsForUnit");
    return diagnosticsByUri;
}

export function abortValidation() {
    validationAbortController.abort();
}

/**
 * Triggers a debounced validation.
 * @param uri The URI of the file that triggered the validation.
 * @param debounce Whether to debounce the validation call.
 * @param allFilesToUpdate A pre-calculated set of all files that need their diagnostics refreshed.
 */
export function triggerValidation(uri: string, debounce: boolean = true, allFilesToUpdate?: Set<string>) {
    validationAbortController.abort();

    if (validationTimers.has(uri)) {
        clearTimeout(validationTimers.get(uri)!);
    }

    validationTimers.set(uri, setTimeout(async () => {
        validationTimers.delete(uri);
        validationAbortController = new AbortController();
        const signal = validationAbortController.signal;

        const fullDiagnosticsByUri = new Map<string, Diagnostic[]>();
        
        // If a specific set of files wasn't provided, calculate it.
        if (!allFilesToUpdate) {
            allFilesToUpdate = new Set(includesGraph.getTranslationUnit(uri));
        }

        const allRoots = Array.from(includesGraph.getIncludingRoots(uri));
        const settings = await getDocumentSettings(uri);

        if (allRoots.length === 0 && includesGraph.isTranslationUnitRoot(uri)) {
            allRoots.push(uri);
        }

        // 1. Initialize full diagnostic list for all potentially affected files to ensure old ones are cleared.
        for (const fileUri of allFilesToUpdate) {
            fullDiagnosticsByUri.set(fileUri, []);
        }
        
        // 2. Gather context-dependent compiler diagnostics from each root.
        const seenCompilerDiags = new Set<string>();
        for (const rootUri of allRoots) {
            if (signal.aborted) return;
            let doc = documents.get(rootUri);
            if (!doc) {
                try {
                    const content = await fs.readFile(URI.parse(rootUri).fsPath, 'utf-8');
                    doc = TextDocument.create(rootUri, 'ca65', 0, content);
                } catch { continue; }
            }
            const compilerDiagnostics = await getCompilerDiagnosticsForUnit(doc, signal);
            for (const [fileUri, diags] of compilerDiagnostics.entries()) {
                const existingDiags = fullDiagnosticsByUri.get(fileUri);
                if (existingDiags) {
                    for (const newDiag of diags) {
                        const messageWithoutContext = newDiag.message.substring(newDiag.message.indexOf(']') + 2);
                        const signature = `${newDiag.range.start.line}:${messageWithoutContext}`;
                        if (!seenCompilerDiags.has(signature)) {
                            existingDiags.push(newDiag);
                            seenCompilerDiags.add(signature);
                        }
                    }
                }
            }
        }

        // 3. Gather context-independent "unused symbol" diagnostics ONCE.
        if (settings.enableUnusedSymbolDiagnostics) {
            const checkedUnusedSymbols = new Set<string>();
            for (const fileUri of allFilesToUpdate) {
                const unusedSymbolDiags = await findUnusedSymbolDiagnostics(fileUri, checkedUnusedSymbols, fullDiagnosticsByUri.get(fileUri) || []);
                if (signal.aborted) return;
                fullDiagnosticsByUri.get(fileUri)?.push(...unusedSymbolDiags);
            }
        }

        // 4. Send the final, consolidated diagnostics for every affected file.
        for (const fileUri of allFilesToUpdate) {
            connection.sendDiagnostics({ uri: fileUri, diagnostics: fullDiagnosticsByUri.get(fileUri) || [] });
        }

    }, debounce ? 500 : 0));
}
