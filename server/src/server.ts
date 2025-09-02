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
import { initializeDiagnostics, triggerValidation } from './diagnostics';
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

// --- Connection and Document Manager Setup ---
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
export let workspaceFolderUris: string[] = [];
export const symbolTables = new Map<string, SymbolTable>();
export const includesGraph = new IncludesGraph();
export const exportsMap = new ExportsMap();

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
    // Load data for mnemonic and directive hovers
    loadAllData(connection);

    // Initial scan of all symbol tables. This is required immediately after initialization since
    // otherwise we will not know the correct includes graph and import/export info for correct
    // symbol resolution.

    let extensionsToScan: string[] = ['s', 'asm', 'inc']; // Default fallback
    try {
        // The server's code is in server/out, so go up two levels to the project root
        const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent);
        
        const langContribution = packageJson.contributes.languages.find(
            (lang: any) => lang.id === 'ca65'
        );
        
        if (langContribution && langContribution.extensions) {
            // Remove the leading '.' from each extension
            extensionsToScan = langContribution.extensions.map(
                (ext: string) => ext.startsWith('.') ? ext.substring(1) : ext
            );
        }
    } catch (e) {
        connection.console.error(`Could not read extensions from package.json: ${e}`);
    }
    const globPattern = `**/*.{${extensionsToScan.join(',')}}`;

    for (const folderUri of workspaceFolderUris) {
        const folderPath = URI.parse(folderUri).fsPath;
        const files = await glob(globPattern, { cwd: folderPath, nodir: true });

        const scannedDocs = new Set<TextDocument>();
        for (const file of files) {
            try {
                const filePath = path.join(folderPath, file);
                const uri = URI.file(filePath).toString();
                const content = await fs.readFile(filePath, 'utf-8');
                const doc = TextDocument.create(uri, 'ca65', 0, content);
                scannedDocs.add(doc);
                
                const symbolTable = await scanDocument(doc);
                symbolTables.set(uri, symbolTable);
                includesGraph.updateIncludes(uri, symbolTable.includedFiles);
                exportsMap.updateExports(uri, symbolTable.exports);
            } catch (e) {
                connection.console.error(`Failed to scan ${file}: ${e}`);
            }
        }
    }
});

// This event is fired when the user changes their settings
connection.onDidChangeConfiguration(change => {
    documentSettings.clear();
    documents.all().forEach(doc => triggerValidation(doc.uri, false));
    connection.languages.inlayHint.refresh();
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
    // Delete cached resolutions of the translation unit both before and after the change
    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        deleteCachedResolutions(uri);
    } 

    const newSymbolTable = await scanDocument(document);
    symbolTables.set(document.uri, newSymbolTable);
    includesGraph.updateIncludes(document.uri, newSymbolTable.includedFiles);
    exportsMap.updateExports(document.uri, newSymbolTable.exports);

    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        deleteCachedResolutions(uri);
    }

    triggerValidation(document.uri, debounce);
}

// --- Event Listeners ---
documents.onDidChangeContent(async (change) => {
    await updateAndValidate(change.document);
});

documents.onDidOpen(async (change) => {
    await updateAndValidate(change.document, false);
});

connection.onDidChangeWatchedFiles(async (params: DidChangeWatchedFilesParams) => {
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
