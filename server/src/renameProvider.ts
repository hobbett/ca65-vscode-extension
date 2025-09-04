import {
    _Connection,
    TextDocuments,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { includesGraph, initializationGate, symbolTables } from './server';
import { getAllReferenceLocationsForEntity, resolveReferenceAtPosition } from './symbolResolver';
import { findAllCheapLocalLabelReferences } from './cheapLocalLabelUtils';

export function initializeRenameProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    /**
     * Handles the "Rename Symbol" request.
     */
    connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
        await initializationGate.isInitialized;
        
        const uri = params.textDocument.uri;
        const document = documents.get(uri);
        const symbolTable = symbolTables.get(uri);
        if (!document || !symbolTable) {
            return null;
        }

        const edits: { [uri: string]: TextEdit[] } = {};
        let allLocations: Location[];

        const foundEntity = resolveReferenceAtPosition(
            uri, params.position, symbolTables, includesGraph
        );
        if (foundEntity) {
            allLocations = getAllReferenceLocationsForEntity(
                foundEntity,
                symbolTables,
                includesGraph
            );
        } else {
            // Didn't find a real symbol, check if it's a cheap label
            allLocations = findAllCheapLocalLabelReferences(document, params.position);
        }

        allLocations.forEach(location => {
            if (!edits[location.uri]) {
                edits[location.uri] = [];
            }
            const textEdit = TextEdit.replace(location.range, params.newName);
            edits[location.uri].push(textEdit);
        });;
        const workspaceEdit: WorkspaceEdit = {
            changes: edits,
        };
        return workspaceEdit;
    });
}
