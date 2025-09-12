import {
    Range,
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Export, ExportKind, ImportKind, Macro, MacroKind, ReferenceInfo, Scope, ScopeKind, Symbol, SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';
// import { getSymbolsAtLine } from './symbolUtils';
import { URI } from 'vscode-uri';
import * as path from 'path';
import { getAnonLabelRefOffsetFromPreviousLabel } from './anonymousLabelUtils';
import { getDocumentSettings, performanceMonitor } from './server';
import { resolveIncludeUri } from './pathUtils';
import { mnemonicData } from './dataManager';

type LineItem = {
    text: string;
    index: number;
};

export function parseLine(line: string): {
    label?: LineItem;
    command?: LineItem;
    args?: LineItem; // the raw text + index for "everything to the right of the command"
    comment?: LineItem;
} {
    function getNextRest(
        rest: string,
        currentOffset: number,
        startIndex: number
    ): [string, number] {
        const afterStart = rest.slice(startIndex);
        const trimmed = afterStart.trimLeft();
        const skipped = afterStart.length - trimmed.length;

        const nextRest = trimmed;
        const nextRestOffset = currentOffset + Math.min(startIndex, rest.length) + skipped;

        return [nextRest, nextRestOffset];
    }

    // Slice the comment off first
    let comment: LineItem | undefined;
    const semicolonIndex = line.indexOf(';');
    if (semicolonIndex >= 0) {
        comment = {text: line.slice(semicolonIndex), index: semicolonIndex};
        line = line.slice(0, semicolonIndex);
    } 

    let label: LineItem | undefined;
    let [rest, restOffset] = getNextRest(line, 0, 0);

    // Get the label to the left of the colon, if any.
    const colonIndex = rest.indexOf(':');
    if (colonIndex >= 0) {
        const nextChar = rest.charAt(colonIndex + 1);
        if (!':<>+-'.includes(nextChar)) {
            const labelText = rest.slice(0, colonIndex).trim();
            if (!labelText.match(/\s+/)) {
                label = { text: labelText, index: restOffset };
                [rest, restOffset] = getNextRest(rest, restOffset, colonIndex + 1);
            }
        }
    }

    // Get the command and args
    let command: LineItem | undefined;
    let args: LineItem | undefined;
    const commandText = rest.trim().split(/\s+/)[0];
    if (commandText) {
        command = { text: commandText, index: restOffset };
        [rest, restOffset] = getNextRest(rest, restOffset, commandText.length);

        if (rest.length > 0) {
            args = { text: rest.trimRight(), index: restOffset }
        }
    }

    return { label, command, args, comment};
}

interface ParsedQualifiedName extends LineItem {
    context: ReferenceInfo[`context`];
}

export function parseQualifiedNames(argsText: string, argsOffset: number = 0): ParsedQualifiedName[][] {
    if (!argsText) return [];

    const allGroups: ParsedQualifiedName[][] = [];
    
    // Use a mutable copy of the text to work with
    let mutableArgsText = argsText;

    mutableArgsText = mutableArgsText
        // mask strings
        .replace(/"([^"]*)"/g, (m, inner) => `"${' '.repeat(inner.length)}"`)
        // mask hex numbers
        .replace(/\$[0-9a-fA-F]+/g, (m) => ' '.repeat(m.length))
        // mask character literals
        .replace(/'([^']*)'/g, (m, inner) => `'${' '.repeat(inner.length)}'`);

    // --- Pass 1: Find and parse all .sizeof expressions ---
    const sizeofRegex = /\.sizeof\s*\(([^)]*)\)/g;
    let sizeofMatch: RegExpExecArray | null;
    while ((sizeofMatch = sizeofRegex.exec(mutableArgsText))) {
        const innerContent = sizeofMatch[1];
        // Calculate the absolute offset of the content within the original string
        const innerOffset = argsOffset + sizeofMatch.index + sizeofMatch[0].indexOf('(') + 1;

        // Run the parsing logic on the inner content with the 'sizeof' context
        let currentGroup: ParsedQualifiedName[] = [];
        const regex = /(::)?\s*([A-Za-z_@][A-Za-z0-9_]*)|(\S)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(innerContent))) {
            const hasDoubleColon = !!match[1];
            const identifier = match[2];
            const unexpected = match[3];

            if (unexpected) {
                if (currentGroup.length > 0) allGroups.push(currentGroup);
                currentGroup = [];
                continue;
            }
            if (!identifier) continue;

            const index = innerOffset + match.index + (identifier ? match[0].indexOf(identifier) : 0);

            if (!hasDoubleColon) {
                if (currentGroup.length > 0) allGroups.push(currentGroup);
                currentGroup = [{ text: identifier, index, context: 'sizeof' }];
            } else {
                if (currentGroup.length === 0) {
                    currentGroup.push({ text: '', index: innerOffset + match.index, context: 'sizeof' });
                }
                currentGroup.push({ text: identifier, index, context: 'sizeof' });
            }
        }
        if (currentGroup.length > 0) allGroups.push(currentGroup);
    }

    // Blank out the .sizeof expressions so they aren't parsed again
    mutableArgsText = mutableArgsText.replace(/\.sizeof\s*\(([^)]*)\)/g, (m) => ' '.repeat(m.length));


    // --- Pass 2: Parse the rest of the text for regular symbols ---
    let currentGroup: ParsedQualifiedName[] = [];
    const mainRegex = /(::)?\s*([A-Za-z_@][A-Za-z0-9_]*)|(\S)/g;
    let mainMatch: RegExpExecArray | null;
    while ((mainMatch = mainRegex.exec(mutableArgsText))) {
        const hasDoubleColon = !!mainMatch[1];
        const identifier = mainMatch[2];
        const unexpected = mainMatch[3];

        if (unexpected) {
            if (currentGroup.length > 0) allGroups.push(currentGroup);
            currentGroup = [];
            continue;
        }
        if (!identifier) continue;

        const index = argsOffset + mainMatch.index + (identifier ? mainMatch[0].indexOf(identifier) : 0);

        if (!hasDoubleColon) {
            if (currentGroup.length > 0) allGroups.push(currentGroup);
            currentGroup = [{ text: identifier, index, context: 'symbol' }];
        } else {
            if (currentGroup.length === 0) {
                currentGroup.push({ text: '', index: argsOffset + mainMatch.index, context: 'symbol' }); // Root scope
            }
            currentGroup.push({ text: identifier, index, context: 'symbol' });
        }
    }
    if (currentGroup.length > 0) allGroups.push(currentGroup);

    return allGroups;
}

export interface ParsedImportExportArgs {
    identifier?: LineItem;
    addressSpecification?: LineItem;
    assignmentOp?: LineItem; // = or :=
    value?: LineItem;
}

export function parseImportExportArgs(text: string, offset: number): ParsedImportExportArgs[] {
    function trimWithOffset(str: string, baseOffset: number): [string, number] {
        const trimmed = str.trimLeft();
        const skipped = str.length - trimmed.length;
        return [trimmed, baseOffset + skipped];
    }

    const groups: ParsedImportExportArgs[] = [];
    let currentOffset = offset;

    for (const rawGroup of text.split(",")) {
        let [rest, restOffset] = trimWithOffset(rawGroup, currentOffset);
        currentOffset += rawGroup.length + 1; // account for comma

        if (!rest) continue;

        const group: ParsedImportExportArgs = {};

        // 1: leading identifier (up to first special token)
        let m = rest.match(/^([^:=\s]+)/);
        if (m) {
            group.identifier = { text: m[1], index: restOffset };
            rest = rest.slice(m[0].length);
            restOffset += m[0].length;
        }

        // trim again
        [rest, restOffset] = trimWithOffset(rest, restOffset);

        // 2: optional ":" identifier
        if (rest.startsWith(":")) {
            rest = rest.slice(1);
            restOffset++;
            [rest, restOffset] = trimWithOffset(rest, restOffset);

            m = rest.match(/^([^:=\s]+)/);
            if (m) {
                group.addressSpecification = { text: m[1], index: restOffset };
                rest = rest.slice(m[0].length);
                restOffset += m[0].length;
            }
            [rest, restOffset] = trimWithOffset(rest, restOffset);
        }

        // 3: optional assignment
        if (rest.startsWith(":=") || rest.startsWith("=")) {
            const op = rest.startsWith(":=") ? ":=" : "=";
            group.assignmentOp = { text: op, index: restOffset };
            rest = rest.slice(op.length);
            restOffset += op.length;

            [rest, restOffset] = trimWithOffset(rest, restOffset);

            if (rest.length > 0) {
                group.value = { text: rest.trimRight(), index: restOffset };
            }
        }

        groups.push(group);
    }

    return groups;
}

export async function scanDocument(document: TextDocument): Promise<SymbolTable> {
    const symbolTable = new SymbolTable(document.uri);
    const settings = await getDocumentSettings(document.uri);
    performanceMonitor.start("scanDocument");
    let currentScope: Scope = symbolTable.getRootScope();
    let currentMacro: Macro | null;

    let currentSegment: string = 'CODE';

    let currentLabel: Symbol | null = null;
    let pendingLabelKindSet: boolean = false;

    let nextAnonLabelIndex = 0;

    const addReferences = (
        line: number,
        text: string,
        offset: number = 0,
        scope: Scope,
        callingEntity?: SymbolTableEntity
    ) => {
        for (const parsedNames of parseQualifiedNames(text, offset)) {
            for (let i = 0; i < parsedNames.length; i++) {
                const name = parsedNames[i].text;
                const index = parsedNames[i].index;
                symbolTable.addReference(new ReferenceInfo(
                    document.uri,
                    name,
                    parsedNames.slice(0, i).map(value => value.text),
                    i === parsedNames.length - 1 ? parsedNames[i].context : `scope`,
                    Range.create(
                        line,
                        index,
                        line,
                        index + name.length
                    ),
                    scope,
                    callingEntity
                ));
            }
        }
    }

    const addSingleReference = (
        context: ReferenceInfo['context'],
        line: number,
        text: string,
        offset: number,
        scope: Scope
    ) => {
        symbolTable.addReference(new ReferenceInfo(
            document.uri,
            text,
            [],
            context,
            Range.create(
                line,
                offset,
                line,
                offset + text.length
            ),
            scope
        ));
    }

    const addAnonymousLabelRefs = (
        line: number,
        text: string,
    ) => {
        let match;
        const anonRefRegex = /:([-+<>]+)/g
        while ((match = anonRefRegex.exec(text)) !== null) {
            const refText = match[0];
            const offset = getAnonLabelRefOffsetFromPreviousLabel(refText);

            let targetIndex = nextAnonLabelIndex - 1 + offset

            if (!symbolTable.anonymousLabelReferences.has(targetIndex)) {
                symbolTable.anonymousLabelReferences.set(targetIndex, []);
            }
            symbolTable.anonymousLabelReferences.get(targetIndex)?.push(
                Range.create(
                    line,
                    match.index,
                    line,
                    match.index + match[0].length
                ),
            );
        }
    }

    const maybeHandleConstantAssignment = (line: number, text: string): boolean => {
        const regex = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*(?:=|:=)/;
        const match = text.match(regex);
        if (!match || !match.groups) return false;
        const { name } = match.groups;
        const nameIndex = text.indexOf(name);
        const definition: Range = Range.create(
            line,
            nameIndex,
            line,
            nameIndex + name.length
        )
        addReferences(line, text, 0, currentScope);
        currentScope.addSymbol(
            name,
            definition,
            SymbolKind.Constant,
        ); 
        return true;
    }

    const maybeHandleVariableAssignment = (line: number, text: string): boolean => {
        const regex = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*\.set\s*(?<value>[^;]*?)(?:\s*;.*)?$/;
        const match = text.match(regex);
        if (!match || !match.groups) return false;
        const { name, value } = match.groups;
        const nameIndex = text.indexOf(name);
        const definition: Range = Range.create(
            line,
            nameIndex,
            line,
            nameIndex + name.length
        )

        addReferences(line, text, 0, currentScope);
        currentScope.addSymbol(
            name,
            definition,
            SymbolKind.Variable,
            currentSegment
        );
        return true;
    }

    const maybeHandleMacroContent = (line: number, text: string): boolean => {
        if (!currentMacro) return false;

        const firstWord = text.trim().split(' ')[0];
        if (!firstWord) return false;

        if (['.endmac', '.endmacro'].includes(firstWord.toLowerCase())) {
            if (currentMacro.range) currentMacro.range.end = {line, character: text.indexOf('.end')}
            currentMacro = null;
        }
        return true;
    }

    const maybeHandleStructUnionContent = (line: number, text: string): boolean => {
        if (![ScopeKind.Struct, ScopeKind.Union].includes(currentScope.kind)) {
            return false;
        }

        const {label, command, args} = parseLine(text);

        const firstWord = command?.text;
        if (!firstWord) return false;
        const cmd = firstWord.toLowerCase();

        if ((currentScope.kind === ScopeKind.Struct && cmd === '.endstruct')
            || (currentScope.kind === ScopeKind.Union && cmd === '.endunion')) {
            if (currentScope.range) currentScope.range.end = {line, character: text.indexOf('.end')}
            if (currentScope.scope) currentScope = currentScope.scope;
            return true;
        }

        if (cmd === '.struct' || cmd === '.union') {
            const argsIndex = args?.index || command.index + command.text.length;
            currentLabel = null;
            let kind: ScopeKind = ScopeKind.Struct;
            if (cmd === '.union') {
                kind = ScopeKind.Union;
            }
            let displayName;
            if (args) {
                addSingleReference('scope', line, args.text, argsIndex, currentScope);
                displayName = args.text
            } else {
                displayName = `<anon line ${line + 1}>`
            }
            currentScope = currentScope.addChildScope(
                displayName,
                Range.create(
                    line,
                    argsIndex,
                    line,
                    argsIndex + displayName.length
                ),
                kind,
            )
            return true;
        }

        const name = firstWord;
        const nameIndex = command.index;
        const definition: Range = Range.create(
            line,
            nameIndex,
            line,
            nameIndex + name.length
        )

        if (args && args.text.toLowerCase().startsWith(`.tag`)) {
            // Struct member is at the command position
            addSingleReference('symbol', line, command.text, command.index, currentScope)
            const argsWithoutTag = args.text.slice(`.tag`.length).trimLeft();
            const indexOfStructName = args.text.length - argsWithoutTag.length + args.index;
            const structName = argsWithoutTag.split(/\s+/)[0];
            if (structName) {
                addSingleReference('scope', line, structName, indexOfStructName, currentScope)
            }
        } else {
            addReferences(line, text, 0, currentScope);
        }
        currentScope.addSymbol(
            firstWord,
            definition,
            SymbolKind.StructMember,
        );
        return true;
    }

    const maybeHandleEnumContent = (line: number, text: string): boolean => {
        if (currentScope.kind !== ScopeKind.Enum) {
            return false;
        }

        const {label, command, args} = parseLine(text);

        const firstWord = command?.text;
        if (!firstWord) return false;
        const cmd = firstWord.toLowerCase();

        if (cmd === '.endenum') {
            if (currentScope.range) currentScope.range.end = {line, character: text.indexOf('.end')}
            if (currentScope.scope) currentScope = currentScope.scope;
            return true;
        }

        const name = firstWord;
        const nameIndex = command.index;
        const definition: Range = Range.create(
            line,
            nameIndex,
            line,
            nameIndex + name.length
        )

        addReferences(line, text, 0, currentScope);
        currentScope.addSymbol(
            firstWord,
            definition,
            SymbolKind.EnumMember,
        );
        return true;
    }

    const maybeHandleGenericLine = (line: number, text: string): boolean => {
        const { label, command, args } = parseLine(text);
        if (label) {
            if (label.text.startsWith('@')) {
                // Cheap local labels are currently handled on-demand.
            } else if (label.text.length === 0) {
                symbolTable.anonymousLabelLines.push(line);
                const indexOfDef = text.indexOf(':');

                if (!symbolTable.anonymousLabelReferences.has(nextAnonLabelIndex)) {
                    symbolTable.anonymousLabelReferences.set(nextAnonLabelIndex, []);
                }
                symbolTable.anonymousLabelReferences.get(nextAnonLabelIndex)?.push(
                    Range.create(
                        line, indexOfDef,
                        line, indexOfDef + 1
                    ),
                );
                nextAnonLabelIndex++;
            } else {
                addSingleReference('symbol', line, label.text, label.index, currentScope);
                currentLabel = currentScope.addSymbol(
                    label.text,
                    Range.create(
                        line,
                        label.index,
                        line,
                        label.index + label.text.length
                    ),
                    SymbolKind.Label,
                    currentSegment
                )
                pendingLabelKindSet = false;
            }
        }

        if (command) {
            const cmd = command.text.toLowerCase();
            const argsText = args?.text || '';
            const argsIndex = args?.index || command.index + command.text.length;
            if (!cmd.startsWith('.') && !mnemonicData[cmd.toUpperCase()]) {
                addSingleReference('macro', line, command.text, command.index, symbolTable.getRootScope());
            }

            switch (cmd) {
                case '.proc': case '.scope': case '.struct': case '.union': case '.enum': {
                    currentLabel = null;
                    let kind: ScopeKind = ScopeKind.Scope;
                    switch (cmd) {
                        case '.proc':
                            kind = ScopeKind.Proc;
                            break;
                        case '.struct':
                            kind = ScopeKind.Struct;
                            break;
                        case '.union':
                            kind = ScopeKind.Union;
                            break;
                        case '.enum':
                            kind = ScopeKind.Enum;
                            break;
                    }
    
                    let name = argsText;
                    if (name) {
                        addSingleReference('scope', line, name, argsIndex, currentScope);
                    } else {
                        name = `<anon line ${line + 1}>`
                    }
                    currentScope = currentScope.addChildScope(
                        name,
                        Range.create(
                            line,
                            argsIndex,
                            line,
                            argsIndex + name.length
                        ),
                        kind,
                        kind === ScopeKind.Proc ? currentSegment : undefined
                    )
                    return true;
                }
                case '.endproc':
                    currentLabel = null;
                    if (!currentScope.scope) break;
                    if (currentScope.kind != ScopeKind.Proc) break;
                    if (currentScope.range) currentScope.range.end = {
                        line, character: text.indexOf('.end')
                    }
                    currentScope = currentScope.scope;
                    return true;
                case '.endscope': {
                    currentLabel = null;
                    if (!currentScope.scope) break;
                    if (currentScope.kind != ScopeKind.Scope) break;
                    if (currentScope.range) currentScope.range.end = {
                        line, character: text.indexOf('.end')
                    }
                    currentScope = currentScope.scope;
                    return true;
                }
                case '.macro': case '.mac': {
                    currentLabel = null;
                    const name = args?.text.split(/\s+/)[0];
                    if (!name) return true;
                    addSingleReference('macro', line, name, argsIndex, currentScope);
                    if (name && !symbolTable.getMacro(name)) {
                        currentMacro = symbolTable.addMacro(
                            name,
                            Range.create(
                                line,
                                argsIndex,
                                line,
                                argsIndex + argsText.length
                            ),
                            MacroKind.Macro,
                        )
                    }
                    return true;
                }
                case '.define': {
                    currentLabel = null;
                    const defMatch = argsText.match(/([a-zA-Z_@.][a-zA-Z0-9_]*)/);
                    const name = defMatch?.[0];
                    if (!name) return true;
                    addSingleReference('macro', line, name, argsIndex, currentScope);
                    if (name && !symbolTable.getMacro(name)) {
                        symbolTable.addMacro(
                            name,
                            Range.create(
                                line,
                                argsIndex,
                                line,
                                argsIndex + name.length
                            ),
                            MacroKind.Define,
                        )
                    }
                    return true;
                }
                case '.segment':
                case '.code':
                case '.data':
                case '.bss':
                case '.zeropage':
                case '.rodata': {
                    currentSegment = (cmd === '.segment') ? argsText.replace(/"/g, '')
                        : cmd.slice(1).toUpperCase();
                    return true;
                }
                case '.import':
                case '.importzp':
                case '.export':
                case '.exportzp':
                case '.global':
                case '.globalzp':
                    const isImport = cmd.startsWith('.import');
                    const isGlobal = cmd.startsWith('.global');
                    const isExport = cmd.startsWith('.export');

                    if (!args) return true;
                    for (const {
                            identifier,
                            addressSpecification,
                            assignmentOp,
                            value
                        } of parseImportExportArgs(args.text, args.index)) {
                        if (!identifier) continue;

                        const identifierRange = Range.create(
                            line,
                            identifier.index,
                            line,
                            identifier.index + identifier.text.length
                        )

                        if (isExport && assignmentOp && value) {
                            // Exports may define a constant in the same line
                            currentScope.addSymbol(
                                identifier.text,
                                identifierRange,
                                SymbolKind.Constant
                            )
                            addReferences(line, value.text, value.index, currentScope);
                        }
                        addSingleReference(
                            'symbol',
                            line,
                            identifier.text,
                            identifier.index,
                            currentScope
                        );

                        if (isImport || isGlobal) {
                            symbolTable.imports.push(
                                currentScope.addImport(
                                    identifier.text,
                                    identifierRange,
                                    isImport ? ImportKind.Import : ImportKind.Global,
                                )
                            )
                        }
                        if (isExport || isGlobal) {
                            symbolTable.exports.push(
                                new Export(
                                    document.uri,
                                    isExport ? ExportKind.Export : ExportKind.Global,
                                    identifier.text,
                                    identifierRange,
                                    currentScope
                                )
                            );
                        }
                    }
                    return true;
                case '.include':
                    const match = argsText.match(/^(['"])(.*)\1$/);
                    if (match) {
                        const filename = match[2];
                        const targetUri =
                            resolveIncludeUri(document.uri, filename, settings.includeDirs);
                        if (targetUri) {
                            symbolTable.includedFiles.push(targetUri);
                        }
                        currentSegment = `segment from ${filename}`;
                    }
                    return true;
            }

            if (currentLabel) {
                // Consume any un-labeled commands as part of the current label
                currentLabel.range.end = { line, character: text.length - 1 };
                // Infer the type of label by the first command
                if (!pendingLabelKindSet) {
                    switch (cmd) {
                        case '.res':
                        case '.tag':
                            currentLabel.kind = SymbolKind.ResLabel;
                            break;
                        case '.addr':
                        case '.align':
                        case '.bankbytes':
                        case '.byt':
                        case '.byte':
                        case '.dbyt':
                        case '.dword':
                        case '.faraddr':
                        case '.word':
                            currentLabel.kind = SymbolKind.DataLabel;
                            break;
                        case '.asciiz':
                            currentLabel.kind = SymbolKind.StringLabel;
                            break;
                        default:
                            // Keep the default 'label'
                            break;
                    }
                    pendingLabelKindSet = true;
                }
            }

            // Parse the args for refs
            if (args) {
                // .tag refs are for structs
                if (cmd === `.tag`) {
                    const structName = args.text.split(/\s+/)[0];
                    if (structName) {
                        addSingleReference('scope', line, structName, args.index, currentScope)
                    }
                    return true;
                }

                let callingEntity;
                if (cmd === 'jsr' || cmd === 'jmp') {
                    if (currentLabel) {
                        callingEntity = currentLabel;
                    } else if (currentScope.kind === ScopeKind.Proc) {
                        callingEntity = currentScope;
                    }
                }
                addReferences(line, args.text, args.index, currentScope, callingEntity);
            }
        }

        return true;
    }

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
        let text = document.getText(
            Range.create(
                lineNumber, 0,
                lineNumber + 1, 0
            )
        );

        if (text.includes(';')) {
            text = text.slice(0, text.indexOf(`;`));
        }

        addAnonymousLabelRefs(lineNumber, text);

        // Order matters
        if (maybeHandleMacroContent(lineNumber, text)) continue;
        if (maybeHandleStructUnionContent(lineNumber, text)) continue;
        if (maybeHandleEnumContent(lineNumber, text)) continue;

        if (maybeHandleConstantAssignment(lineNumber, text)) continue;
        if (maybeHandleVariableAssignment(lineNumber, text)) continue;
        if (maybeHandleGenericLine(lineNumber, text)) continue;
        // Empty line?
    }

    // Close any open scopes at EOF
    let openScope: Scope | null = currentScope;
    while (openScope != null) {
        openScope.range.end = {
            line: document.lineCount, character: 0
        };
        openScope = openScope.scope;
    }
    performanceMonitor.stop("scanDocument");
    // symbolTable.dump();
    return symbolTable;
}
