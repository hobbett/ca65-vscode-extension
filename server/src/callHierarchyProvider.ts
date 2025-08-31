import {
    _Connection,
    TextDocuments,
    CallHierarchyPrepareParams,
    CallHierarchyItem,
    CallHierarchyIncomingCallsParams,
    CallHierarchyIncomingCall,
    CallHierarchyOutgoingCallsParams,
    CallHierarchyOutgoingCall,
} from 'vscode-languageserver/node';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { includesGraph, symbolTables } from './server';
import { getAllReferencesForEntity, resolveReferenceAtPosition, getLSPSymbolKind, resolveReference } from './symbolResolver';
import { Scope, ScopeKind, Symbol, SymbolTableEntity } from './symbolTable';

export function initializeCallHierarchyProvider(
    connection: _Connection,
    documents: TextDocuments<TextDocument>
) {
    connection.languages.callHierarchy.onPrepare(
        async (
            params: CallHierarchyPrepareParams
        ): Promise<CallHierarchyItem[] | null> => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }

            const foundEntity = resolveReferenceAtPosition(
                params.textDocument.uri, params.position, symbolTables, includesGraph
            );
            if (!foundEntity) {
                return null;
            }

            if (foundEntity instanceof Symbol
                || (foundEntity instanceof Scope && foundEntity.kind === ScopeKind.Proc)) {
                return [{
                    kind: getLSPSymbolKind(foundEntity),
                    name: foundEntity.getQualifiedName(),
                    uri: foundEntity.uri,
                    range: foundEntity.range,
                    selectionRange: foundEntity.definition,
                    data: {
                        uri: foundEntity.uri,
                        name: foundEntity.name,
                        scopeStack: foundEntity.getScopeStack()
                    },
                }];
            }
            return null;
        }
    );

    connection.languages.callHierarchy.onIncomingCalls(
        async (
            params: CallHierarchyIncomingCallsParams
        ): Promise<CallHierarchyIncomingCall[] | null> => {
            if (!params.item.data) return null;
            const {uri, name, scopeStack} = params.item.data;
            if (!uri || !name || !scopeStack ) return null;

            
            const symbolTable = symbolTables.get(uri);
            if (!symbolTable) return null;

            const entity = symbolTable.getRootScope().findDefinition(name, scopeStack, 'symbol');
            if (!entity) return null;

            const allReferences = getAllReferencesForEntity(
                entity,
                symbolTables,
                includesGraph
            );

            // 3. Group references by the function/scope they are called FROM.
            const callsByCaller = new Map<SymbolTableEntity, Range[]>();
            for (const ref of allReferences) {
                if (ref.callingEntity) {
                    if (!callsByCaller.has(ref.callingEntity)) {
                        callsByCaller.set(ref.callingEntity, []);
                    }
                    // The range of the call is the reference's location.
                    callsByCaller.get(ref.callingEntity)!.push(ref.location);
                }
            }

            // 4. Format the results from the grouped map.
            const incomingCalls: CallHierarchyIncomingCall[] = [];
            for (const [caller, ranges] of callsByCaller.entries()) {
                if (!uri) continue;
                incomingCalls.push({
                    from: {
                        kind: getLSPSymbolKind(caller),
                        name: caller.getQualifiedName(),
                        uri: caller.uri,
                        range: caller.range,
                        selectionRange: caller.definition,
                        data: {
                            uri: caller.uri,
                            name: caller.name,
                            scopeStack: caller.getScopeStack()
                        },
                    },
                    fromRanges: ranges,
                });
            }

            return incomingCalls;
        });

    connection.languages.callHierarchy.onOutgoingCalls(
        async (
            params: CallHierarchyOutgoingCallsParams
        ): Promise<CallHierarchyOutgoingCall[] | null> => {
            if (!params.item.data) return null;
            const {uri, name, scopeStack} = params.item.data;
            if (!uri || !name || !scopeStack ) return null;
            
            const symbolTable = symbolTables.get(uri);
            if (!symbolTable) return null;

            const entity = symbolTable.getRootScope().findDefinitionOrImport(name, scopeStack, 'symbol');
            if (!entity) return null;

            const outgoingReferences =
                symbolTable.references.filter(ref => ref.callingEntity === entity);

            // 3. Resolve each outgoing reference and group them by what they call (the definition).
            const callsByDefinition = new Map<SymbolTableEntity, Range[]>();
            for (const ref of outgoingReferences) {
                const resolvedEntity =
                    resolveReference(ref, symbolTables, includesGraph);
                if (resolvedEntity) {
                    if (!callsByDefinition.has(resolvedEntity)) {
                        callsByDefinition.set(resolvedEntity, []);
                    }
                    // The range of the call is the reference's location.
                    callsByDefinition.get(resolvedEntity)!.push(ref.location);
                }
            }
            
            // 4. Format the results.
            const outgoingCalls: CallHierarchyOutgoingCall[] = [];
            for (const [calledEntity, ranges] of callsByDefinition.entries()) {
                outgoingCalls.push({
                    to: {
                        kind: getLSPSymbolKind(calledEntity),
                        name: calledEntity.getQualifiedName(),
                        uri: calledEntity.uri,
                        range: calledEntity.range,
                        selectionRange: calledEntity.definition,
                        data: {
                            uri: calledEntity.uri,
                            name: calledEntity.name,
                            scopeStack: calledEntity.getScopeStack()
                        },
                    },
                    fromRanges: ranges
                });
            }
            
            return outgoingCalls;
        });
}
