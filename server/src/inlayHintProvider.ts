import {
    _Connection,
    TextDocuments,
    InlayHintParams,
    InlayHint,
    InlayHintKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import { resolveImport } from './symbolResolver';
import { getRelativePath } from './pathUtils';
import { documentSettings } from './settings';

export function initializeInlayHintProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.languages.inlayHint.on(async (params: InlayHintParams): Promise<InlayHint[]> => {
        await initializationGate.isInitialized;
        
        const document = documents.get(params.textDocument.uri);
        if (!document) return [];
        const symbolTable = symbolTables.get(document.uri);
        if (!symbolTable) return [];

        const settings = await getDocumentSettings(document.uri);
        const inlayHints: InlayHint[] = [];

        // Anonymous label index hints
        if (settings.anonymousLabelIndexHints) {
            const references = symbolTable.anonymousLabelReferences;
            if (references) {
                for (const labelIndex of references.keys()) {
                    const ranges = references.get(labelIndex);
                    if (!ranges) continue;
                    for (const range of ranges) {
                        inlayHints.push({
                            label: `L${labelIndex + 1}`,
                            position: { line: range.start.line, character: range.start.character },
                            kind: InlayHintKind.Parameter,
                        });
                    }
                }
            }
        }

        // Import statement `from file` hints
        if (settings.importFromHints) {
            for (const importInfo of symbolTable.imports) {
                const resolvedImport = resolveImport(importInfo.name, symbolTables, includesGraph);
                if (!resolvedImport) continue;
    
                const relativeUri = getRelativePath(document.uri, resolvedImport.uri);
    
                inlayHints.push({
                    label: ` from ${relativeUri}`,
                    position: {
                        line: importInfo.definition.end.line,
                        character: importInfo.definition.end.character
                    },
                    kind: InlayHintKind.Parameter,
                    paddingLeft: false,
                });
            }
        }

        return inlayHints;
    });
}
