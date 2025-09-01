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
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { execFile } from 'child_process';
import { URI } from 'vscode-uri';
import { getDocumentSettings, includesGraph } from './server'; // Assumes these are exported from your server
import * as fs from 'fs/promises';
import * as os from "os";
import { promisify } from 'util';
import { Ca65Settings } from './settings';
import which from "which";
import { resolveWorkspaceRelativeDirs } from './pathUtils';

const execFileAsync = promisify(execFile);

const validationTimers: Map<string, NodeJS.Timeout> = new Map();
let connection: _Connection;
let documents: TextDocuments<TextDocument>;
let hasShownCa65NotFoundMessage = false;

export function initializeDiagnostics(conn: _Connection, docs: TextDocuments<TextDocument>) {
    connection = conn;
    documents = docs;
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
    // Check the user's explicit setting first.
    if (settings.executablePath) {
        let expandedPath = settings.executablePath;
        if (expandedPath.startsWith("~")) {
            expandedPath = path.join(os.homedir(), expandedPath.slice(1));
        }
        expandedPath = path.resolve(expandedPath); // resolve relative paths

        if (await isExecutable(expandedPath)) {
            console.log(`Found ca65 at settings path ${expandedPath}`);
            return expandedPath;
        }
    }

    // Try system path
    try {
        const pathInSystem = await which('ca65');
        if (pathInSystem) {
            console.log(`Found ca65 at which path ${pathInSystem}`);
            return pathInSystem;
        }
    } catch (e) {
        // Not found in PATH, continue to the next step.
    }

    // Try ~/.local/bin
    const localBinPath = path.join(os.homedir(), '.local', 'bin', 'ca65');
    if (await isExecutable(localBinPath)) {
        console.log(`Found ca65 at ${localBinPath}`);
        return localBinPath;
    }

    console.log(`Did not find ca65 executable`);
    return null;
}

/**
 * Validates a document by running ca65 and sends diagnostics for all affected files.
 */
export async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const settings = await getDocumentSettings(textDocument.uri);
    const ca65Path = await findCa65Executable(settings);
    if (!ca65Path) {
        if (!hasShownCa65NotFoundMessage) {
            connection.window.showErrorMessage(
                'ca65 executable not found. Please ensure ca65 is in your system PATH, or set '
                + 'the "ca65.executablePath" in your settings.'
            );
            hasShownCa65NotFoundMessage = true;
        }
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
        return;
    }

    // Find the ca65 executable using the new search logic
    const filePath = URI.parse(textDocument.uri).fsPath;
    const baseDir = path.dirname(filePath);
    const diagnosticsByUri = new Map<string, Diagnostic[]>();
    const args = [filePath, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'];

    for (const includeDir of resolveWorkspaceRelativeDirs(textDocument.uri, settings.includeDirs)) {
        args.push('-I');
        args.push(includeDir);
    }

    for (const binIncludeDir of resolveWorkspaceRelativeDirs(textDocument.uri, settings.binIncludeDirs)) {
        args.push('--bin-include-dir');
        args.push(binIncludeDir);
    }

    let stderr = '';
    try {
        // --- Handle the SUCCESS case ---
        // If ca65 succeeds, the result object contains stdout and stderr.
        const result = await execFileAsync(ca65Path, args);
        stderr = result.stderr;
    } catch (err: any) {
        // --- Handle the ERROR case ---
        // If ca65 fails, the error object contains stderr.
        if (err && err.stderr) {
            stderr = err.stderr;
        }
    }

    if (stderr) {
        const lines = stderr.split(/\r?\n/);
        const errorRegex = /^(.*?):(\d+):\s(Warning|Error):\s(.*)$/;
        const noteRegex = /^(.*?):(\d+):\sNote:\s(.*)$/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const errorMatch = line.match(errorRegex);

            if (errorMatch) {
                const [_, fileName, lineNumberStr, severityStr, message] = errorMatch;
                const errorFilePath = path.resolve(baseDir, fileName);
                const errorFileUri = URI.file(errorFilePath).toString();
                const lineNumber = parseInt(lineNumberStr, 10) - 1;

                if (!diagnosticsByUri.has(errorFileUri)) {
                    diagnosticsByUri.set(errorFileUri, []);
                }

                const diagnostic: Diagnostic = {
                    severity: severityStr === 'Error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                    range: Range.create(lineNumber, 0, lineNumber + 1, 0),
                    message: message,
                    source: 'ca65',
                    relatedInformation: []
                };

                let errorDocument = documents.get(errorFileUri);
                if (!errorDocument) {
                    try {
                        const content = await fs.readFile(errorFilePath, 'utf-8');
                        errorDocument = TextDocument.create(errorFileUri, 'ca65-asm', 0, content);
                    } catch (e) {
                        // File not found, etc. Continue with no document.
                    }
                }

                if (errorDocument) {
                    const symbolMentionRegex = /[‘](.*?)[’]/;
                    const symbolMentionMatch = message.match(symbolMentionRegex);

                    const lineText = errorDocument.getText(Range.create(lineNumber, 0, lineNumber + 1, 0));
                    const lineWithoutComment = (lineText.includes(';') ? lineText.slice(lineText.indexOf(';')) : lineText).trimEnd()

                    // Trim the diagnostic range to the actual content
                    diagnostic.range = Range.create(
                        lineNumber,
                        lineWithoutComment.length - lineWithoutComment.trimStart().length,
                        lineNumber,
                        lineWithoutComment.length
                    );

                    // Handle symbol mentions
                    if (symbolMentionMatch) {
                        const symbolName = symbolMentionMatch[1];
                        const symbolIndex = lineText.indexOf(symbolName);

                        // Trim the diagnostic to the mentioned symbol
                        if (symbolIndex !== -1) {
                            diagnostic.range = Range.create(lineNumber, symbolIndex, lineNumber, symbolIndex + symbolName.length); 
                        }
                    }
                }

                // --- Handle "Note:" lines for related information ---
                if (i + 1 < lines.length) {
                    const noteMatch = lines[i + 1].match(noteRegex);
                    if (noteMatch) {
                        const [_, noteFileName, noteLineNumberStr, noteMessage] = noteMatch;
                        const noteFilePath = path.resolve(baseDir, noteFileName);
                        const noteFileUri = URI.file(noteFilePath).toString();
                        diagnostic.relatedInformation = [{
                            location: {
                                uri: noteFileUri,
                                range: Range.create(parseInt(noteLineNumberStr, 10) - 1, 0, parseInt(noteLineNumberStr, 10), 0)
                            },
                            message: noteMessage
                        }];
                        i++; // Skip the note line
                    }
                }

                diagnosticsByUri.get(errorFileUri)!.push(diagnostic);
            }
        }
    }

    // --- Send all collected diagnostics, clearing old ones ---
    const allAffectedUris = includesGraph.getTransitiveDependencies(textDocument.uri);
    for (const uri of allAffectedUris) {
        const diagnostics = diagnosticsByUri.get(uri) || [];
        connection.sendDiagnostics({ uri, diagnostics });
    }
}

/**
 * Triggers a debounced validation for a given document.
 * If the document is included by other files, we will only validate the root files that include it
 * and reuse that ca65 run's output.
 */
export function triggerValidation(uri: string, debounce: boolean = true) {
    if (validationTimers.has(uri)) {
        clearTimeout(validationTimers.get(uri)!);
    }
    validationTimers.set(uri, setTimeout(async () => {
        validationTimers.delete(uri);

        for (const affectedUri of includesGraph.getIncludingRoots(uri)) {
            let doc = documents.get(affectedUri);
            if (!doc) {
                const filePath = URI.parse(affectedUri).fsPath;
                const content = await fs.readFile(filePath, 'utf-8');
                doc = TextDocument.create(affectedUri, 'ca65', 0, content);
            }
            validateTextDocument(doc);
        }
    }, debounce ? 500 : 0));
}
