import { Location, Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { symbolTables } from './server';

/**
 * Finds the definition location for an anonymous label reference.
 * @param document The document to scan.
 * @param position The position of the reference.
 * @returns The Location of the definition, or null if not found.
 */
export function getAnonymousLabelDefinition(
    document: TextDocument,
    position: Position,
): Location | null {
    const symbolTable = symbolTables.get(document.uri);
    if (!symbolTable) return null;

    const index = getAnonymousLabelIndex(document, position);
    if (index === undefined) return null;
    const defLine = symbolTable.anonymousLabelLines[index]
    if (defLine === undefined) return null;

    const defPos = document.getText(Range.create(defLine, 0, defLine + 1, 0)).indexOf(':');
    return Location.create(
        document.uri,
        Range.create(
            defLine, defPos,
            defLine, defPos + 1
        )
    )
}

export function getAnonLabelRefOffsetFromPreviousLabel(label: string) {
    const symbols = label.slice(1);
    if (symbols.startsWith('+') || symbols.startsWith('>')) {
        return symbols.length
    } else {
        return 1 - symbols.length;
    }
}

export function findPreviousAnonymousLabelIndex(
    document: TextDocument,
    lineNumber: number
): number {
    const symbolTable = symbolTables.get(document.uri);
    if (!symbolTable) return -1;

    // Basic binary search
    let anonLines = symbolTable.anonymousLabelLines;
    let start = 0;
    let end = anonLines.length;
    let closestMatch = -1;
    while (start < end) {
        const searchIndex = Math.floor((end - start) / 2) + start 
        const candidate = anonLines[searchIndex]
        if (lineNumber === candidate) {
            return searchIndex;
        }
        if (lineNumber > candidate) {
            closestMatch = searchIndex
            start = searchIndex + 1;
        } else {
            end = searchIndex;
        }
    }
    return closestMatch;
}

export function getAnonymousLabelIndex(
    document: TextDocument,
    position: Position,
): number | undefined {
    const text = document.getText(Range.create(position.line, 0, position.line + 1, 0));
    const symbolTable = symbolTables.get(document.uri);
    if (!symbolTable) return -1;

    const previousAnonLabelIndex = findPreviousAnonymousLabelIndex(document, position.line);

    // Check if we're at the definition already
    if (symbolTable.anonymousLabelLines[previousAnonLabelIndex] === position.line) {
        const defPos = text.indexOf(':');
        if (defPos === position.character || defPos + 1 === position.character) {
            return previousAnonLabelIndex;
        }
    }

    let match;
    const anonRefRegex = /:([-+<>]+)/g
    while ((match = anonRefRegex.exec(text)) !== null) {
        const refText = match[0];
        if (position.character < match.index
            || position.character > match.index + refText.length) {
            continue;
        }

        const offset = getAnonLabelRefOffsetFromPreviousLabel(refText);
        let targetIndex = previousAnonLabelIndex + offset
        // Not a valid index.
        if (targetIndex < 0 || targetIndex >= symbolTable.anonymousLabelLines.length) return -1;

        return targetIndex;
    }
}

export function findAllAnonLabelReferences(
    document: TextDocument,
    position: Position,
): Location[] {
    const allAnonLabelRefs = symbolTables.get(document?.uri)?.anonymousLabelReferences;
    if (!allAnonLabelRefs) return [];

    // First, find the anon label the position is referencing
    const index = getAnonymousLabelIndex(document, position)
    if (index === undefined) return [];

    const ranges = allAnonLabelRefs.get(index);
    if (!ranges) return [];

    const locations: Location[] = []
    for (const range of ranges) {
        locations.push({
            uri: document.uri,
            range
        })
    };
    return locations
}
