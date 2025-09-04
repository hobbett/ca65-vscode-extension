import {
    _Connection,
    FoldingRangeParams,
    FoldingRange,
    FoldingRangeKind
} from 'vscode-languageserver/node';
import { initializationGate, symbolTables } from './server';

export function initializeFoldingRangeProvider(connection: _Connection) {
    connection.onFoldingRanges(async (params: FoldingRangeParams): Promise<FoldingRange[]> => {
        await initializationGate.isInitialized;

        const symbolTable = symbolTables.get(params.textDocument.uri);
        if (!symbolTable) return [];

        const foldingRanges: FoldingRange[] = [];

        for (const entity of symbolTable.getAllDefinedEntities()) {
            if (entity.range && entity.range.start.line < entity.range.end.line) {
                foldingRanges.push({
                    startLine: entity.range.start.line,
                    endLine: entity.range.end.line,
                    kind: FoldingRangeKind.Region
                });
            }
        }

        return foldingRanges;
    });
}
