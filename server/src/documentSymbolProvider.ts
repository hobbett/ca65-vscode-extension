import {
    _Connection,
    DocumentSymbolParams,
    DocumentSymbol,
} from 'vscode-languageserver/node';
import { symbolTables } from './server';
import { Scope } from './symbolTable';
import { getLSPSymbolKind } from './symbolResolver';

export function initializeDocumentSymbolProvider(connection: _Connection) {
    connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] | undefined => {
        const symbolTable = symbolTables.get(params.textDocument.uri);
        if (!symbolTable) return undefined;

        // Recursive function to convert our Symbol/Scope hierarchy to DocumentSymbols
        function getDocumentSymbols(scope: Scope): DocumentSymbol[] {
            const symbols: DocumentSymbol[] = [];

            // Add all symbols in this scope
            for (const sym of scope.getSymbols()) {
                symbols.push({
                    name: sym.name,
                    kind: getLSPSymbolKind(sym),
                    range: sym.range,
                    selectionRange: sym.definition,
                    children: undefined, // symbols don't have children
                    detail: sym.segment && sym.segment !== 'CODE'? `(${sym.segment})` : undefined,
                });
            }

            // Add child scopes recursively
            for (const childScope of scope.getChildScopes()) {
                const children = getDocumentSymbols(childScope);
                symbols.push({
                    name: childScope.name,
                    kind: getLSPSymbolKind(childScope),
                    range: childScope.range,
                    selectionRange: childScope.definition,
                    children: children.length > 0 ? children : undefined,
                    detail: childScope.segment && childScope.segment !== 'CODE'
                        ? `(${childScope.segment})` : undefined,
                });
            }

            return symbols;
        } 

        const rootSymbols = getDocumentSymbols(symbolTable.getRootScope());

        // Add macros at the top level
        for (const macro of symbolTable.getAllMacros()) {
            rootSymbols.push({
                name: macro.name,
                kind: getLSPSymbolKind(macro),
                range: macro.range,
                selectionRange: macro.definition,
                children: undefined,
            });
        }

        return rootSymbols;
    });
}
