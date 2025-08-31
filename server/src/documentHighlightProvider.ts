import {
    _Connection,
    TextDocuments,
    DocumentHighlightParams,
    DocumentHighlight,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { includesGraph, symbolTables } from './server';
import { findAllCheapLocalLabelReferences } from './cheapLocalLabelUtils';
import { findAllAnonLabelReferences } from './anonymousLabelUtils';
import { getAllReferenceLocationsForEntity, resolveReferenceAtPosition } from './symbolResolver';

export function initializeDocumentHighlightProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] | undefined => {
        const document = documents.get(params.textDocument.uri);
        const symbolTable = symbolTables.get(params.textDocument.uri);
        if (!document || !symbolTable) {
            return undefined;
        }

        // First, try to find a standard symbol at the cursor's position.
        const foundEntity = resolveReferenceAtPosition(
            params.textDocument.uri, params.position, symbolTables, includesGraph
        );
        if (foundEntity) {

            const refLocations = getAllReferenceLocationsForEntity(
                foundEntity, symbolTables, includesGraph
            );

            return refLocations.filter(loc => loc.uri === document.uri)
                .map(loc => DocumentHighlight.create(loc.range));
        }

        const cheapLocalLabelRefs = findAllCheapLocalLabelReferences(document, params.position);
        if (cheapLocalLabelRefs?.length > 0) {
            return cheapLocalLabelRefs.map(loc => DocumentHighlight.create(loc.range));
        }

        const anonLabelRefs = findAllAnonLabelReferences(document, params.position);
        if (anonLabelRefs?.length > 0) {
            return anonLabelRefs.map(loc => DocumentHighlight.create(loc.range));
        }

        return undefined;
    });
}