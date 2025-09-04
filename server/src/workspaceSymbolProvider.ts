import {
    _Connection,
    WorkspaceSymbolParams,
    SymbolInformation,
} from 'vscode-languageserver/node';
import { initializationGate, symbolTables } from './server';
import { getLSPSymbolKind } from './symbolResolver';

export function initializeWorkspaceSymbolProvider(connection: _Connection) {
    /**
     * Handles the "Go to Symbol in Workspace" request (Ctrl+T).
     */
    connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[]> => {
        await initializationGate.isInitialized;

        const query = params.query.toLowerCase();
        const lspSymbols: SymbolInformation[] = [];

        for (const [uri, symbolTable] of symbolTables) {
            for (const entity of symbolTable.getAllDefinedEntities()) {

                if (query && !entity.name.toLowerCase().includes(query)) {
                    continue;
                }

                lspSymbols.push({
                    name: entity.getFullyQualifiedName(),
                    kind: getLSPSymbolKind(entity),
                    location: { uri, range: entity.definition },
                });
            }
        }

        return lspSymbols;
    });
}
