import {
    Position,
    SymbolKind as LSPSymbolKind,
    Location,
} from 'vscode-languageserver-types';
import { SymbolTable, Symbol, SymbolTableEntity, Macro, Scope, ScopeKind, MacroKind, SymbolKind, ReferenceInfo, Export, Import } from './symbolTable';
import { IncludesGraph } from './includesGraph';
import { exportsMap, performanceMonitor, symbolTables } from './server';
import { Ca65Settings } from './settings';

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
    includesGraph: IncludesGraph,
    implicitImports: boolean
): SymbolTableEntity | undefined {

    const symbolTable = allSymbolTables.get(uri);
    if (!symbolTable) {
        return undefined;
    }

    const ref = symbolTable.getReferenceAtPosition(position);
    if (!ref) {
        return undefined;
    }
    const resolved = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
    return resolved;
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
    implicitImports: boolean
): SymbolTableEntity | undefined {
    performanceMonitor.start('resolveReference');

    const localReference = resolveLocalReference(ref, allSymbolTables, includesGraph);

    // We found an import. Now check all of the exported symbols in the workspace.
    // If there is no exported symbol, treat the import itself as the definition since we may
    // be looking at a library header.
    if (localReference instanceof Import) {
        const resolvedImport = resolveImport(localReference.name, symbolTables, includesGraph);
        performanceMonitor.stop('resolveReference');
        return resolvedImport ? resolvedImport : localReference; 
    }

    // If we didn't find a local reference, and implicit imports are enabled,
    // and this is a symbol reference in the global scope, try to resolve it as an implicit import.
    if (
        !localReference
        && implicitImports
        && ref.context === 'symbol'
        && (ref.qualifiers.length === 0 || ref.qualifiers[0].length === 0 /* Global scope */)
    ) {
        const impliedImport = resolveImport(ref.name, symbolTables, includesGraph);
        performanceMonitor.stop('resolveReference');
        return impliedImport;
    }

    // Nothing doing.
    performanceMonitor.stop('resolveReference');
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
        return cachedResolution
    }
    performanceMonitor.start('resolveLocalReference_uncached');

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
                performanceMonitor.stop('resolveLocalReference_uncached');
                return macro;
            }
        }
        performanceMonitor.stop('resolveLocalReference_uncached');
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
            if (localEntity instanceof Import) {
                importEntity = localEntity;
                break;
            }
            cachedResolutions.set(ref, localEntity);
            performanceMonitor.stop('resolveLocalReference_uncached');
            return localEntity;
        }
    }

    if (importEntity) {
        cachedResolutions.set(ref, importEntity);
        performanceMonitor.stop('resolveLocalReference_uncached');
        return importEntity;
    }

    performanceMonitor.stop('resolveLocalReference_uncached');
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
        if (resolved) {
            return resolved;
        }
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
        return cachedResolution
    }
    performanceMonitor.start('resolveExport_uncached');
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
            performanceMonitor.stop('resolveExport_uncached');
            return foreignEntity;
        }
    }
    performanceMonitor.stop('resolveExport_uncached');
    return undefined;
}

export function getAllReferencesForEntity(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): ReferenceInfo[] {
    performanceMonitor.start('getAllReferencesForEntity');
    const allRefs: ReferenceInfo[] = [];

    for (const symbolTable of allSymbolTables.values()) {
        for (const ref of symbolTable.getAllReferences()) {
            if (ref.name !== entity.name) continue;

            const refResult = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
            if (refResult !== entity) continue;
            
            allRefs.push(ref);
        }
    }

    performanceMonitor.stop('getAllReferencesForEntity');
    return allRefs;
}

export function getAllReferenceLocationsForEntity(
    entity: SymbolTableEntity,  
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean = false
): Location[] {
    return getAllReferencesForEntity(entity, allSymbolTables, includesGraph, implicitImports)
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

export function isEntityUsed(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): boolean {
    performanceMonitor.start("isEntityUsed");
    let refCount: number = 0;
    for (const translationUnitUri of includesGraph.getTranslationUnit(entity.uri)) {
        const symbolTable = allSymbolTables.get(translationUnitUri);
        if (!symbolTable) continue;

        for (const ref of symbolTable.getAllReferences()) {
            if (ref.name !== entity.name) continue;
            if (resolveLocalReference(ref, allSymbolTables, includesGraph)) {
                refCount++;
                // Check if the ref count is more than 1 (the definition).
                if (refCount > 1) {
                performanceMonitor.stop("isEntityUsed");
                    return true;
                }
            }
        }
    }
    performanceMonitor.stop("isEntityUsed");
    return false;
}
