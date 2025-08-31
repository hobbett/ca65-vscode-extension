import {
    _Connection,
    TextDocuments,
    Definition,
    DefinitionParams,
    Range,
    Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getAnonymousLabelDefinition } from './anonymousLabelUtils';
import { findCheapLocalLabelDefinition } from './cheapLocalLabelUtils';
import { resolveReferenceAtPosition } from './symbolResolver';
import { includesGraph, symbolTables } from './server';

export function initializeDefinitionProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    /**
     * Handles the "Go to Definition" request.
     */
    connection.onDefinition((params: DefinitionParams): Definition | undefined => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return undefined;
        }

        const foundEntity = resolveReferenceAtPosition(
            params.textDocument.uri, params.position, symbolTables, includesGraph
        );

        if (foundEntity) {
            return Location.create(foundEntity.uri, foundEntity.definition);
        }

        // Fallback for special, non-symbol labels
        const lineText = document.getText(Range.create(
            params.position.line, 0,
            params.position.line + 1, 0
        ));

        function isCursorOnMatch(cursor: number, match: RegExpExecArray) {
            return cursor >= match.index! && cursor <= match.index! + match[0].length;
        }

        const cheapRegex = /@[\w]+/g;
        let m: RegExpExecArray | null;
        while ((m = cheapRegex.exec(lineText)) !== null) {
            if (isCursorOnMatch(params.position.character, m)) {
                const defCheap = findCheapLocalLabelDefinition(document, params.position, m[0]);
                if (defCheap) return defCheap;
                break; // stop after first match under cursor
            }
        }

        const anonLabelDef = getAnonymousLabelDefinition(document, params.position);
        if (anonLabelDef) return anonLabelDef;
    });
}
