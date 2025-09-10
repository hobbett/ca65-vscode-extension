import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    TextDocumentSyncKind,
    DidChangeWatchedFilesParams,
    FileChangeType,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';

import { loadAllData } from './dataManager';
import { abortValidation, initializeDiagnostics, triggerValidation } from './diagnostics';
import { initializeDocumentSymbolProvider } from './documentSymbolProvider';
import { scanDocument } from './documentScanner';
import { initializeFoldingRangeProvider } from './foldingRangeProvider';
import { initializeDocumentLinkProvider } from './documentLinkProvider';
import { initializeWorkspaceSymbolProvider } from './workspaceSymbolProvider';
import { initializeInlayHintProvider } from './inlayHintProvider';
import { IncludesGraph } from './includesGraph';
import { SymbolTable } from './symbolTable';
import { initializeHoverProvider } from './hoverProvider';
import { initializeReferencesProvider } from './referencesProvider';
import { initializeDefinitionProvider } from './definitionProvider';
import { initializeRenameProvider } from './renameProvider';
import { initializeCallHierarchyProvider } from './callHierarchyProvider';
import { initializeDocumentHighlightProvider } from './documentHighlightProvider';
import { initializeCompletionProvider } from './completionProvider';
import { deleteCachedResolutions } from './symbolResolver';
import { ExportsMap } from './exportsMap';
import { Ca65Settings, documentSettings } from './settings';
import { Performance as PerformanceMonitor } from './performance';

// --- Connection and Document Manager Setup ---
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
export let workspaceFolderUris: string[] = [];
export const symbolTables = new Map<string, SymbolTable>();
export const includesGraph = new IncludesGraph();
export const exportsMap = new ExportsMap();
export const performanceMonitor = new PerformanceMonitor();

export const initializationGate = (() => {
    let resolve: () => void;
    const promise = new Promise<void>(r => {
        resolve = r;
    });
    return {
        isInitialized: promise,
        open: () => resolve(),
    };
})();

// --- Server Initialization ---
connection.onInitialize(async (params: InitializeParams) => {
    if (params.workspaceFolders) {
        workspaceFolderUris = params.workspaceFolders.map(folder => folder.uri);
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Full,
            hoverProvider: true,
            documentSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            foldingRangeProvider: true,
            documentLinkProvider: { resolveProvider: false },
            callHierarchyProvider: true,
            renameProvider: true,
            workspaceSymbolProvider: true,
            completionProvider: {
                triggerCharacters: ['.', '@'],
            },
            inlayHintProvider: { resolveProvider: false },
            documentHighlightProvider: true,
            workspace: {
                workspaceFolders: { supported: true }
            }
        },
    };
});

connection.onInitialized(async () => {
    try {
        // Load data for mnemonic and directive hovers
        loadAllData(connection);

        // Initial scan of all symbol tables. This is required immediately after initialization since
        // otherwise we will not know the correct includes graph and import/export info for correct
        // symbol resolution.
        performanceMonitor.start('onInitialized');

        // Define default glob patterns for file discovery. These are used if no user configuration is found.
        const defaultGlobs = ['**/*.s', '**/*.asm', '**/*.inc'];
        let configuredGlobs: string[] = [];

        try {
            // Fetch the user's file associations directly from the client (VS Code).
            // This correctly handles user settings like "*.a65": "ca65".
            const config = await connection.workspace.getConfiguration({ section: 'files' });
            const associations = config?.associations || {};

            // Filter for associations that point to the 'ca65' language ID.
            configuredGlobs = Object.entries(associations)
                .filter(([_pattern, langId]) => langId === 'ca65')
                .map(([pattern, _langId]) => {
                    // Ensure simple patterns like '*.s' are treated as recursive across all directories.
                    if (!pattern.includes('/') && !pattern.includes('\\')) {
                        return `**/${pattern}`;
                    }
                    return pattern;
                });
        } catch (e) {
            connection.console.error(`Could not fetch 'files.associations' from client: ${e}`);
        }

        // Cross-editor compatible: Fetch additional extensions from our own settings.
        try {
            const ca65Config = await connection.workspace.getConfiguration({ section: 'ca65' });
            const customExtensions = ca65Config?.additionalExtensions || [];
            const customGlobs = customExtensions.map((ext: string) => {
                // Ensure extension starts with a dot, then create glob.
                const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
                return `**/*${cleanExt}`;
            });
            configuredGlobs.push(...customGlobs);
        } catch (e) {
            connection.console.error(`Could not fetch 'ca65.additionalExtensions' from client: ${e}`);
        }

        // Combine defaults with user settings, removing any duplicates.
        const allGlobs = [...new Set([...defaultGlobs, ...configuredGlobs])];

        for (const folderUri of workspaceFolderUris) {
            const folderPath = URI.parse(folderUri).fsPath;
            // The glob library accepts an array of patterns, so we pass all of them.
            const files = await glob(allGlobs, { cwd: folderPath, nodir: true });

            const docs = [];
            for (const file of files) {
                try {
                    const filePath = path.join(folderPath, file);
                    const uri = URI.file(filePath).toString();
                    const content = await fs.readFile(filePath, 'utf-8');
                    const doc = TextDocument.create(uri, 'ca65', 0, content);
                    
                    docs.push(doc);
                    symbolTables.set(uri, new SymbolTable(doc.uri));
                } catch (e) {
                    connection.console.error(`Failed to scan ${file}: ${e}`);
                }
            }

            for (const doc of docs) {
                const symbolTable = await scanDocument(doc);
                symbolTables.set(doc.uri, symbolTable);
                includesGraph.updateIncludes(doc.uri, symbolTable.includedFiles);
                exportsMap.updateExports(doc.uri, symbolTable.exports);
            }
        }
    } catch (e) {
        connection.console.error(`A critical error occurred during initialization: ${e}`);
    }
    performanceMonitor.stop('onInitialized');

    initializationGate.open();
});

// Helper function to get the setting for a document
export function getDocumentSettings(resource: string): Thenable<Ca65Settings> {
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'ca65'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// --- Central Document Update and Validation Logic ---
async function updateAndValidate(document: TextDocument, debounce: boolean = true) {
    await initializationGate.isInitialized;
    abortValidation();
    performanceMonitor.start('updateAndValidate');

    const allAffectedUris: Set<string> = new Set();

    // Delete cached resolutions of the translation unit both before and after the change
    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        allAffectedUris.add(uri);
    } 

    const newSymbolTable = await scanDocument(document);
    symbolTables.set(document.uri, newSymbolTable);
    includesGraph.updateIncludes(document.uri, newSymbolTable.includedFiles);
    exportsMap.updateExports(document.uri, newSymbolTable.exports);

    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        allAffectedUris.add(uri);
    }

    for (const uri of allAffectedUris) {
        deleteCachedResolutions(uri);
    }

    triggerValidation(document.uri, debounce, allAffectedUris);
    performanceMonitor.stop('updateAndValidate');
}

// Custom request from the client to dump performance stats
connection.onRequest('ca65/dumpPerformanceStats', () => {
    connection.console.info(performanceMonitor.getReport());
});

// Custom request from the client to dump performance stats
connection.onRequest('ca65/dumpSymbolTables', () => {
    for (const [uri, table] of symbolTables) {
        connection.console.info(`Symbol Table for ${uri}:`);
        table.dump();
    }
});

// Custom request from the client to dump include graph
connection.onRequest('ca65/dumpIncludesGraph', () => {
    connection.console.info('Current Includes Graph:');
    connection.console.info(includesGraph.toString());
});

// Custom request from the client to dump exports map
connection.onRequest('ca65/dumpExportsMap', () => {
    connection.console.info('Current Exports Map:');
    exportsMap.dump();
});

// Custom request from the client to dump symbol tables
connection.onRequest('ca65/dumpSymbolTables', () => {
    for (const [uri, table] of symbolTables) {
        connection.console.info(`Symbol Table for ${uri}:`);
        table.dump();
    }
});

// --- Event Listeners ---
documents.onDidChangeContent(async (change) => {
    await updateAndValidate(change.document);
});

documents.onDidOpen(async (change) => {
    await updateAndValidate(change.document, false);
});

connection.onDidChangeWatchedFiles(async (params: DidChangeWatchedFilesParams) => {
    await initializationGate.isInitialized;

    connection.console.log('Watched file change detected. Re-scanning affected files.');
    for (const event of params.changes) {
        const openDoc = documents.get(event.uri);
        if (openDoc) {
            // Already handled via onDidSave or onDidChangeContent
            continue;
        }

        // Handle files not currently open
        try {
            if (event.type === FileChangeType.Deleted) {
                for (const uri of includesGraph.getTranslationUnit(event.uri)) {
                    deleteCachedResolutions(uri);
                }
                triggerValidation(event.uri, false);
                symbolTables.delete(event.uri);
                includesGraph.removeFile(event.uri);
                exportsMap.removeUri(event.uri);
                continue;
            }

            const filePath = URI.parse(event.uri).fsPath;
            const content = await fs.readFile(filePath, 'utf-8');
            const doc = TextDocument.create(event.uri, 'ca65', 0, content);
            await updateAndValidate(doc);
        } catch (err) {
            connection.console.error(`Failed to handle watched file: ${event.uri}, error: ${err}`);
        }
    }
});

// --- Initialize Features from Modules ---
initializeDiagnostics(connection, documents);
initializeHoverProvider(connection, documents);
initializeDocumentSymbolProvider(connection);
initializeDefinitionProvider(connection, documents);
initializeReferencesProvider(connection, documents);
initializeFoldingRangeProvider(connection);
initializeDocumentLinkProvider(connection, documents);
initializeCallHierarchyProvider(connection, documents);
initializeRenameProvider(connection, documents);
initializeWorkspaceSymbolProvider(connection);
initializeCompletionProvider(connection, documents);
initializeInlayHintProvider(connection, documents);
initializeDocumentHighlightProvider(connection, documents);

// --- Start the server ---
documents.listen(connection);
connection.listen();
