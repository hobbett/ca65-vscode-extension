import {
    Position,
    SymbolKind as LSPSymbolKind,
    Location,
} from 'vscode-languageserver-types';
import { SymbolTable, Symbol, SymbolTableEntity, Macro, Scope, ScopeKind, MacroKind, SymbolKind, ReferenceInfo, Export, Import } from './symbolTable';
import { IncludesGraph } from './includesGraph';
import { exportsMap, symbolTables } from './server';

const cachedLocalResolutionsPerUri: Map<string, Map<ReferenceInfo, SymbolTableEntity>> = new Map();
const cachedExportResolutionsPerUri: Map<string, Map<Export, Symbol | Scope>> = new Map();

export function deleteCachedResolutions(uri: string) {
    cachedLocalResolutionsPerUri.delete(uri);
    cachedExportResolutionsPerUri.delete(uri);
}

export function resolveReferenceAtPosition(
    uri: string,
    position: Position,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): SymbolTableEntity | undefined {
    const symbolTable = allSymbolTables.get(uri);
    if (!symbolTable) return undefined;

    const ref = symbolTable.getReferenceAtPosition(position);
    if (!ref) return undefined;
    return resolveReference(ref, allSymbolTables, includesGraph);
}

/**
 * Resolves a reference to its definitive SymbolTableEntity.
 * It searches locally, through includes, and across the workspace via imports/exports.
 * @param ref The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveReference(
    ref: ReferenceInfo,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph, // Assuming your include graph type
): SymbolTableEntity | undefined {

    const localReference = resolveLocalReference(ref, allSymbolTables, includesGraph);

    // We found an import. Now check all of the exported symbols in the workspace.
    // If there is no exported symbol, treat the import itself as the definition since we may
    // be looking at a library header.
    if (localReference instanceof Import) {
        const resolvedImport = resolveImport(localReference.name, symbolTables, includesGraph);
        return resolvedImport ? resolvedImport : localReference; 
    }

    // Nothing doing.
    return localReference;
}

/**
 * Resolves a reference within a translation unit.
 */
export function resolveLocalReference(
    ref: ReferenceInfo,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph, // Assuming your include graph type
): SymbolTableEntity | undefined {
    const cachedResolution = cachedLocalResolutionsPerUri.get(ref.uri)?.get(ref);
    if (cachedResolution) {
        console.log('Returning cached local resolution for ' + ref.name);
        return cachedResolution
    }
    let cachedResolutions: Map<ReferenceInfo, SymbolTableEntity> | undefined
        = cachedLocalResolutionsPerUri.get(ref.uri);
    if (!cachedResolutions) {
        cachedResolutions = new Map();
        cachedLocalResolutionsPerUri.set(ref.uri, cachedResolutions)
    }

    // Macros have a flat, non-lexical namespace within a file and its includes.
    if (ref.context === 'macro') {
        for (const uri of includesGraph.getTranslationUnit(ref.uri)) {
            const symbolTable = allSymbolTables.get(uri);
            if (!symbolTable) continue;

            const macro = symbolTable.getMacro(ref.name);
            if (macro) {
                cachedResolutions.set(ref, macro);
                return macro;
            }
        }
        return undefined; // No preceding macro found
    }

    // Try to find the symbol in our locally visible files
    let importEntity: Import | undefined;
    for (const uri of includesGraph.getTranslationUnit(ref.uri)) {
        const symbolTable = symbolTables.get(uri);
        if (!symbolTable) continue;

        let localEntity;
        if (uri === ref.uri) {
            localEntity = ref.scope.findDefinitionOrImport(ref.name, ref.qualifiers, ref.context);
        } else {
            localEntity =
                symbolTable.getRootScope().findDefinitionOrImport(ref.name, ref.qualifiers, ref.context);
        }

        if (localEntity) {
            // Break early if it's an import, since we know that it should be exported. If it is a
            // global, we don't yet know if it is an exporting global (i.e. the symbol is defined
            // within the current translation unit) or if it is an importing global. Thus, continue
            // searching within the translation unit in case it is defined elsewhere.
            if (localEntity instanceof Import) {
                importEntity = localEntity;
                break;
            }
            cachedResolutions.set(ref, localEntity);
            return localEntity;
        }
    }

    if (importEntity) {
        cachedResolutions.set(ref, importEntity);
        return importEntity;
    }

    return undefined;
}

/**
 * Resolves an import to the symbol that exports it across the workspace.
 * @param importEntity The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveImport(
    importName: string,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): Symbol | Scope | undefined {
    for (const exportEntity of exportsMap.get(importName)) {
        const resolved = resolveExport(exportEntity, allSymbolTables, includesGraph);
        if (resolved) return resolved;
    }
    return undefined;
}

/**
 * Resolves an export to the symbol's definition within it's translation unit.
 * @param importEntity The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveExport(
    exportEntity: Export,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): Symbol | Scope | undefined {
    const cachedResolution = cachedExportResolutionsPerUri.get(exportEntity.uri)?.get(exportEntity);
    if (cachedResolution) {
        console.log('Returning cached export for ' + exportEntity.name);
        return cachedResolution
    }
    let cachedResolutions: Map<Export, Symbol | Scope> | undefined
        = cachedExportResolutionsPerUri.get(exportEntity.uri);
    if (!cachedResolutions) {
        cachedResolutions = new Map();
        cachedExportResolutionsPerUri.set(exportEntity.uri, cachedResolutions)
    }

    for (const translationUnitUri of includesGraph.getTranslationUnit(exportEntity.uri)) {
        const translationUnitSymbolTable = allSymbolTables.get(translationUnitUri);
        if (!translationUnitSymbolTable) continue;

        let foreignEntity;
        let searchScope;
        if (translationUnitUri === exportEntity.uri && exportEntity.scope) {
            searchScope = exportEntity.scope;
        } else {
            searchScope = translationUnitSymbolTable.getRootScope();
        }
        foreignEntity = searchScope.findDefinition(
            exportEntity.name,
            exportEntity.scope?.getScopeStack() ?? [],
            'symbol'
        );
        if (!foreignEntity) continue;

        if (foreignEntity instanceof Symbol
            || foreignEntity instanceof Scope && foreignEntity.kind === ScopeKind.Proc) {
            cachedResolutions.set(exportEntity, foreignEntity);
            return foreignEntity;
        }
    }
    return undefined;
}

export function getAllReferencesForEntity(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): ReferenceInfo[] {
    const allRefs: ReferenceInfo[] = [];

    for (const symbolTable of allSymbolTables.values()) {
        for (const ref of symbolTable.getAllReferences()) {
            if (ref.name !== entity.name) continue;

            const refResult = resolveReference(ref, allSymbolTables, includesGraph);
            if (refResult !== entity) continue;
            
            allRefs.push(ref);
        }
    }

    return allRefs;
}

export function getAllReferenceLocationsForEntity(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): Location[] {
    return getAllReferencesForEntity(entity, allSymbolTables, includesGraph)
        .map((ref) => { return { uri: ref.uri, range: ref.location }})
}

export function getLSPSymbolKind(item: SymbolTableEntity): LSPSymbolKind {
    if (item instanceof Macro) {
        switch (item.kind) {
            case MacroKind.Define: return LSPSymbolKind.Constant;
            default: return LSPSymbolKind.Function;
        }
    }

    if (item instanceof Symbol) {
        switch (item.kind) {
            case SymbolKind.ResLabel: return LSPSymbolKind.Variable;
            case SymbolKind.DataLabel: return LSPSymbolKind.Array;
            case SymbolKind.StringLabel: return LSPSymbolKind.String;
            case SymbolKind.Constant: return LSPSymbolKind.Constant;
            case SymbolKind.Variable: return LSPSymbolKind.Variable;
            case SymbolKind.StructMember: return LSPSymbolKind.Field;
            case SymbolKind.EnumMember: return LSPSymbolKind.EnumMember;
            default: return LSPSymbolKind.Key;
        }
    }

    if (item instanceof Scope) {
        switch (item.kind) {
            case ScopeKind.Proc: return LSPSymbolKind.Function;
            case ScopeKind.Struct:
            case ScopeKind.Union: return LSPSymbolKind.Struct;
            case ScopeKind.Enum: return LSPSymbolKind.Enum;
            default: return LSPSymbolKind.Namespace;
        }
    }

    // Fallback if unknown
    return LSPSymbolKind.Key;
}

export function getFullyQualifiedName(item: SymbolTableEntity): string {
    const nameParts: string[] = [item.name];
    let currentScope = item.scope;

    // Walk up the parent scope chain until we reach the root
    while (currentScope && currentScope.name !== '') {
        nameParts.unshift(currentScope.name);
        currentScope = currentScope.scope;
    }

    return nameParts.join('::');
}
