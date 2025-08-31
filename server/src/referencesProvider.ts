import {
    _Connection,
    TextDocuments,
    Location,
    ReferenceParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { includesGraph, symbolTables } from './server';
import { findAllCheapLocalLabelReferences } from './cheapLocalLabelUtils';
import { findAllAnonLabelReferences } from './anonymousLabelUtils';
import { getAllReferenceLocationsForEntity, resolveReferenceAtPosition } from './symbolResolver';

export function initializeReferencesProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    /**
     * Handles the "Find All References" request using a pre-calculated reference map
     * and searching across all files in the workspace.
     */
    connection.onReferences((params: ReferenceParams): Location[] | undefined => {
        const uri = params.textDocument.uri;
        const document = documents.get(uri);
        const symbolTable = symbolTables.get(uri);
        if (!document || !symbolTable) {
            return undefined;
        }
        
        const foundEntity = resolveReferenceAtPosition(
            uri, params.position, symbolTables, includesGraph
        );

        if (foundEntity) {
            return getAllReferenceLocationsForEntity(
                foundEntity,
                symbolTables,
                includesGraph
            );
        }

        // Didn't find a real symbol, check if it's a cheap or anonymous reference.
        const cheapLocalRefs = findAllCheapLocalLabelReferences(document, params.position);
        if (cheapLocalRefs.length > 0) {
            return cheapLocalRefs;
        }

        const anonLabelRef = findAllAnonLabelReferences(document, params.position);
        if (anonLabelRef.length > 0) {
            return anonLabelRef;
        }
        return;
    });
}
