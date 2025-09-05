import {
    Position,
    Range,
} from 'vscode-languageserver-types';
import { performanceMonitor } from './server';

export class SymbolTableEntity {
    range: Range;

    constructor(
        public uri: string,
        public name: string,
        public definition: Range,
        public scope: Scope | null,
        public segment?: string | null
    ) {
        this.name = name;
        this.definition = definition;
        this.scope = scope;
        this.range = Range.create(definition.start, definition.end);
    }

    getFullyQualifiedName(): string {
        return `::` + [...this.getScopeStack(), this.name].join('::');
    }

    getQualifiedName(): string {
        return [...this.getScopeStack(), this.name].join('::');
    }

    getScopeStack(): string[] {
        const scopeStack = [];
        let scope = this.scope;
        while (scope && scope.name !== '') {
            scopeStack.unshift(scope.name);
            scope = scope.scope
        }
        return scopeStack;
    }
}

export enum SymbolKind {
    Label = "label",    
    ResLabel = "res label",
    DataLabel = "data label",
    StringLabel = "string label",
    Constant = "constant",
    Variable = "variable",
    StructMember = "struct member",
    EnumMember = "enum member",
}

export class Symbol extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: SymbolKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public segment?: string,
    ) {
        super(uri, name, definition, parentScope);
        this.segment = segment;
    }
}

export enum ImportKind {
    Import = "import",
    Global = "global import"
}

export class Import extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: ImportKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
    ) {
        super(uri, name, definition, parentScope);
    }
}


export enum ExportKind {
    Export = "export",
    Global = "global export"
}

export class Export extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: ExportKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
    ) {
        super(uri, name, definition, parentScope);
    }
}

export enum ScopeKind {
    Scope = "scope",
    Proc = "proc",
    Struct = "struct",
    Union = "union",
    Enum = "enum",
}

export class Scope extends SymbolTableEntity {
    private childScopes: Map<string, Scope[]> = new Map();
    private symbols: Map<string, Symbol[]> = new Map();
    private imports: Map<string, Import[]> = new Map();

    constructor(
        uri: string,
        public kind: ScopeKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public segment?: string,
    ) {
        super(uri, name, definition, parentScope, segment);
    }

    addSymbol(
        name: string,
        definition: Range,
        kind: SymbolKind,
        segment?: string
    ): Symbol {
        if (!this.symbols.has(name)) {  
            this.symbols.set(name, []);
        }
        const symbol = new Symbol(this.uri, kind, name, definition, this, segment);
        this.symbols.get(name)?.push(symbol);
        return symbol;
    }

    addImport(
        name: string,
        definition: Range,
        kind: ImportKind,
    ): Import {
        if (!this.imports.has(name)) {  
            this.imports.set(name, []);
        }
        const importEntity = new Import(this.uri, kind, name, definition, this);
        this.imports.get(name)?.push(importEntity);
        return importEntity;
    }

    addChildScope(name: string, definition: Range, kind: ScopeKind, segment?: string): Scope {
        if (!this.childScopes.has(name)) {  
            this.childScopes.set(name, []);
        }
        const scope = new Scope(this.uri, kind, name, definition, this, segment);
        this.childScopes.get(name)?.push(scope);
        return scope;
    }

    getSymbol(name: string): Symbol | undefined {
        const arr = this.symbols.get(name);
        if (!arr) return undefined;

        // Prefer exports and global last in case the symbol is defined in the same scope.
        return arr[0];
    }

    getSymbols(): Iterable<Symbol> {
        return (function* (values: Iterable<Symbol[]>) {
            for (const arr of values) {
                yield* arr;
            }
        })(this.symbols.values());
    }

    getImport(name: string): Import | undefined {
        const arr = this.imports.get(name);
        if (!arr) return undefined;

        // Prefer exports and global last in case the symbol is defined in the same scope.
        return arr[0];
    }

    getImports(): Iterable<Import> {
        return (function* (values: Iterable<Import[]>) {
            for (const arr of values) {
                yield* arr;
            }
        })(this.imports.values());
    }

    getChildScope(name: string): Scope | undefined {
        return this.childScopes.get(name)?.[0];
    }

    getChildScopes(): Iterable<Scope> {
        return (function* (values: Iterable<Scope[]>) {
            for (const arr of values) {
                yield* arr;
            }
        })(this.childScopes.values());
    }

    private findName(
        name: string,
        qualifiers: string[],
        context: ReferenceInfo['context'],
        allowImports: boolean
    ): SymbolTableEntity | undefined {
        let currentBaseScope: Scope | null = this;
        while (currentBaseScope) {
            if (!currentBaseScope.scope) {
                // Clip off the global scope qualifier if we're at the top.
                if (qualifiers[0]?.length === 0) {
                    qualifiers = qualifiers.slice(1);
                }
            }

            let nextScope: Scope | undefined = currentBaseScope;
            for (let i = 0; i < qualifiers.length; i++) {
                nextScope = nextScope.getChildScope(qualifiers[i]);
                if (!nextScope) break;
            }

            if (nextScope) {
                const resolvedScope = nextScope.getChildScope(name);
                if (
                    resolvedScope
                    && (
                        context === 'scope'
                        || context === `sizeof`
                        || resolvedScope.kind === ScopeKind.Proc
                    )
                ) {
                    return resolvedScope;
                }

                const resolvedSymbol = nextScope.getSymbol(name);
                if (resolvedSymbol && (context === 'symbol' || context === `sizeof`)) {
                    return resolvedSymbol;
                }

                if (allowImports && context === 'symbol') {
                    const resolvedImport = nextScope.getImport(name);
                    if (resolvedImport) return resolvedImport;
                }
            }
            currentBaseScope = currentBaseScope.scope; // Walk up to the parent
        }
    }

    /**
     * Finds the shortest, unambiguous name for a given entity, relative to the current scope.
     * It does this by testing progressively more qualified names until one resolves back
     * to the original entity.
     * @param entity The entity to find a name for.
     * @param context The resolution context (symbol, scope, etc.).
     * @returns The shortest relative name as a string (e.g., "Loop" or "Player::Loop").
     */
    public findRelativeName(
        entity: SymbolTableEntity,
    ): string {
        // Macro is unaffected by scopes
        if (entity instanceof Macro) {
            return entity.name;
        }

        const name = entity.name;
        const entityScopeStack = entity.getScopeStack();

        // Test names from least qualified (just the name) to most qualified.
        let foundConflict = false;
        for (let i = 0; i <= entityScopeStack.length; i++) {
            // On i=0, testQualifiers is []. We test just "name".
            // On i=1, we take the last element of the stack. We test "parentScope::name".
            // And so on, until we test the full path.
            const testQualifiers = entityScopeStack.slice(entityScopeStack.length - i);
            
            let context: ReferenceInfo[`context`] = `symbol`;
            if (entity instanceof Scope) {
                context = `scope`
            }
            const resolvedEntity = this.findDefinitionOrImport(name, testQualifiers, context);
            if (!resolvedEntity) continue;

            // If resolving this test name from our current scope gives us back
            // the original entity, we've found the shortest unambiguous name.

            if (resolvedEntity === entity) {
                return [...testQualifiers, name].join('::');
            }

            foundConflict = true;
        }

        // If we didn't find our entity or any entity with the same same, the symbol may be defined
        // in a different file. If so, we don't need the '::' leader since the other file's symbols
        // will always be searched from the root scope and won't be shadowed by a local symbol.
        if (!foundConflict) {
            return [...entityScopeStack, name].join('::')
        }

        // As a final fallback, if no relative name works (e.g., for a global symbol
        // shadowed by a local one), use the absolute fully qualified name.
        return entity.getFullyQualifiedName();
    }

    findDefinitionOrImport(
        name: string,
        qualifiers: string[],
        context: ReferenceInfo['context']
    ): SymbolTableEntity | undefined {
        return this.findName(name, qualifiers, context, true);
    }

    findDefinition(
        name: string,
        qualifiers: string[],
        context: ReferenceInfo['context']
    ): SymbolTableEntity | undefined {
        return this.findName(name, qualifiers, context, false);
    }
}

export enum MacroKind {
    Macro = "macro",
    Define = "define",
}

export class Macro extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: MacroKind,
        name: string,
        definition: Range,
    ) {
        super(uri, name, definition, null);
    }
}

export class ReferenceInfo {
    constructor(
        public uri: string,
        public name: string,
        public qualifiers: string[], // Partially qualified parts of the referenced name
        public context: 'symbol' | 'scope' | 'macro' | 'sizeof',
        public location: Range,
        public scope: Scope,
        // Effective calling entity for call hierarchy analysis.
        public callingEntity?: SymbolTableEntity,
    ) {}
}

/**
 * The main container for all parsed information for a file.
 */
export class SymbolTable {
    private rootScope: Scope;
    private macros: Map<string, Macro> = new Map();

    public references: ReferenceInfo[] = [];
    public memoizedReferences: Map<ReferenceInfo, SymbolTableEntity> = new Map();

    public includedFiles: string[] = [];

    public anonymousLabelLines: number[] = [];
    public anonymousLabelReferences: Map<number, Range[]> = new Map();

    public imports: Import[] = [];
    public exports: Export[] = [];

    constructor(public uri: string) {
        this.rootScope = new Scope(
            uri,
            ScopeKind.Scope,
            '',
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
            null,
        );
    }

    getUri(): string {
        return this.uri;
    }

    getRootScope(): Scope {
        return this.rootScope;
    }

    addMacro(
        name: string,
        definition: Range,
        kind: MacroKind,
    ): Macro {
        const macro = new Macro(this.uri, kind, name, definition);
        this.macros.set(name, macro);
        return macro;
    }

    getMacro(
        name: string,
    ): Macro | undefined {
        return this.macros.get(name);
    }

    getAllMacros(): Macro[] {
        return Array.from(this.macros.values()).sort((a, b) => a.range.start.line - b.range.start.line);
    }

    /**
     * Adds a record of a symbol/scope/macro usage found during parsing.
     * @param info A detailed object describing the reference.
     */
    public addReference(info: ReferenceInfo): void {
        this.references.push(info);
    }

    /**
     * Traverses the entire tree once to collect all defined items.
     * @returns An object containing flat lists of all symbols, scopes, and macros. Note that this
     *          exclues imports and exports.
     */
    getAllDefinedEntities(): SymbolTableEntity[] {
        const symbols: Symbol[] = [];
        const scopes: Scope[] = [];

        function traverse(scope: Scope) {
            // Add the scope itself (excluding the unnamed root)
            if (scope.name !== '') {
                scopes.push(scope);
            }

            // Add all symbols from the current scope
            symbols.push(...scope.getSymbols());

            // Recurse into children
            for (const child of scope.getChildScopes()) {
                traverse(child);
            }
        }

        traverse(this.rootScope);

        return [
            ...symbols,
            ...scopes,
            ...this.getAllMacros(), // Reuse the existing sorted macro list
        ];
    }

    getAllReferences(): ReferenceInfo[] {
        return this.references;
    }

    getReferenceAtPosition(position: Position): ReferenceInfo | null {
        performanceMonitor.start('getReferenceAtPosition');
        // TODO: make this more performant, possibly with binary search.
        for (const reference of this.references) {
            // Range includes the character after a reference. This is to allow the cursor at the
            // end of the reference to still refer to it for highlights.
            if (
                this.isPositionInRange(position, reference.location)
                || position.character > 0
                && this.isPositionInRange(
                    {line: position.line, character: position.character - 0},
                    reference.location
                )
            ) {
                performanceMonitor.stop('getReferenceAtPosition');
                return reference
            }
        }
        performanceMonitor.stop('getReferenceAtPosition');
        return null
    }

    // A helper function to check if a position is within a range.
    isPositionInRange(position: Position, range: Range): boolean {
        if (position.line < range.start.line || position.line > range.end.line) {
            return false;
        }
        if (position.line === range.start.line && position.character < range.start.character) {
            return false;
        }
        if (position.line === range.end.line && position.character > range.end.character) {
            return false;
        }
        return true;
    }

    /**
     * Recursively finds the most specific scope at a given position.
     * @param scope The scope to search within (start with the file's root scope).
     * @param position The cursor's position.
     * @returns The most specific scope containing the position, or undefined.
     */
    getScopeAtPosition(position: Position, scope: Scope = this.rootScope): Scope | undefined {
        // TODO: Make this function more expedient, possibly using binary search.
        // 1. First, check if the position is even within this scope. If not, we're done.
        if (!this.isPositionInRange(position, scope.range)) return;

        // 2. Recursively search the child scopes. A child is always more specific.
        for (const childScope of scope.getChildScopes()) {
            const foundInChild = this.getScopeAtPosition(position, childScope);
            if (foundInChild) {
                // We found a more specific scope inside a child, so that's our answer.
                return foundInChild;
            }
        }

        // 3. The position is in this scope, but not in any of its children.
        //    Therefore, this is the most specific scope.
        return scope;
    }

    /**
     * Pretty-print the entire symbol table: scopes, symbols, macros, and references.
     */
    dump(): void {
        console.log("=== Symbol Table Dump ===");

        // --- Root Scope ---
        const traverseScope = (scope: Scope, indent = 0) => {
            const pad = '  '.repeat(indent);
            const name = scope.name || '<root>';
            console.log(`${pad}- Scope: ${name} [${scope.kind}] (${scope.range.start.line}:${scope.range.start.character} - ${scope.range.end.line}:${scope.range.end.character})`);

            // Symbols
            for (const sym of scope.getSymbols()) {
                console.log(`${pad}  * Symbol: ${sym.name} [${sym.kind}] (${sym.range.start.line}:${sym.range.start.character} - ${sym.range.end.line}:${sym.range.end.character})${sym.segment ? ' Segment: ' + sym.segment : ''}`);
            }

            // Recurse child scopes
            for (const child of scope.getChildScopes()) {
                traverseScope(child, indent + 1);
            }
        };

        traverseScope(this.getRootScope());

        // --- Includes ---
        if (this.includedFiles.length > 0) {
            console.log("\n--- Included Files ---");
            for (const file of this.includedFiles) {
                console.log(`* ${file}`);
            }
        }

        // --- Macros ---
        const allMacros = this.getAllMacros();
        if (allMacros.length > 0) {
            console.log("\n--- Macros ---");
            for (const macro of allMacros) {
                console.log(`* Macro: ${macro.name} [${macro.kind}] (${macro.range.start.line}:${macro.range.start.character} - ${macro.range.end.line}:${macro.range.end.character})`);
            }
        }

        // --- References ---
        if (this.references.length > 0) {
            console.log("\n--- References ---");
            for (const ref of this.references) {
                const qualifiers = [...ref.qualifiers, ref.name].join('::');
                const scopeStr = ref.scope ? `${ref.scope.getFullyQualifiedName()}` : 'null';
                console.log(`* Context: ${ref.context}, Qualified Name: ${qualifiers}, Scope: ${scopeStr}, Location: (${ref.location.start.line}:${ref.location.start.character} - ${ref.location.end.line}:${ref.location.end.character}), Calling Entity: (${ref.callingEntity ? ref.callingEntity.getFullyQualifiedName() : 'undefined'})`);
            }
        }

        console.log("=== End of Symbol Table Dump ===");
    }
}
