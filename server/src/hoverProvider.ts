import {
    _Connection,
    TextDocuments,
    Hover,
    MarkupKind,
    TextDocumentPositionParams,
    Range,
    SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as fs from 'fs/promises';

import { mnemonicData, directiveData } from './dataManager';
import { Macro, SymbolTableEntity } from './symbolTable';
import { getLSPSymbolKind, resolveReference } from './symbolResolver';
import { includesGraph, initializationGate, symbolTables } from './server';

export function initializeHoverProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onHover(async ({ textDocument, position }: TextDocumentPositionParams): Promise<Hover | undefined> => {
        await initializationGate.isInitialized;
        
        const document = documents.get(textDocument.uri);
        if (!document) return undefined;
        const symbolTable = symbolTables.get(textDocument.uri);
        if (!symbolTable) return undefined;

        const ref = symbolTable.getReferenceAtPosition(position);
        if (ref) {
            const foundEntity = resolveReference(
                ref,
                symbolTables,
                includesGraph
            );
            if (foundEntity) {
                let definitionDocument = documents.get(foundEntity.uri);
                console.log(`resolved entity ${foundEntity}`);

                if (!definitionDocument) {
                    try {
                        const filePath = URI.parse(foundEntity.uri).fsPath;
                        const content = await fs.readFile(filePath, 'utf-8');
                        // Create a temporary document object for the hover generator
                        definitionDocument = TextDocument.create(foundEntity.uri, 'ca65-lsp', 0, content);
                    } catch (e) {
                        connection.console.error(`Failed to read file for hover: ${foundEntity.uri}`);
                        return undefined; // Can't show hover if we can't read the file
                    }
                }

                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: generateSymbolTableEntityMarkdown(foundEntity, definitionDocument)
                    },
                    range: ref?.location 
                };
            };
        };

        // Fallback for mnemonics and directives
        const lineText = document.getText({ start: { line: position.line, character: 0 }, end: { line: position.line, character: Number.MAX_VALUE } });
        const wordRegex = /[.a-zA-Z_][a-zA-Z0-9_]*/g;
        let match;

        while ((match = wordRegex.exec(lineText)) !== null) {
            const start = match.index!;
            const end = start + match[0].length;

            if (position.character >= start && position.character <= end) {
                const word = match[0];
                const hoverRange = Range.create(position.line, start, position.line, end);

                if (word.startsWith('.')) {
                    const name = word.slice(1).toUpperCase();
                    console.log(`word starts with . yo: ${name}`);
                    let data = directiveData[name];
                    if (typeof data === 'string') data = directiveData[data];
                    if (data) {
                        return { contents: { kind: MarkupKind.Markdown, value: generateDirectiveHoverMarkdown(word, data) }, range: hoverRange };
                    }
                } else {
                    const name = word.toUpperCase();
                    const data = mnemonicData[name];
                    if (data) {
                        return { contents: { kind: MarkupKind.Markdown, value: generateMnemonicHoverMarkdown(word, data) }, range: hoverRange };
                    }
                }
                return undefined;
            }
        }

        return undefined;
    });
}


// --- Markdown Generation Functions ---

function generateSymbolTableEntityMarkdown(entity: SymbolTableEntity, document: TextDocument): string {
    const definitionStart = entity.definition.start.line;
    let rangeEnd = entity.range ? entity.range.end.line : definitionStart;

    const commentLines: string[] = [];
    let hasExport = false;
    for (let i = definitionStart - 1; i >= 0; i--) {
        const lineText = document.getText({
            start: { line: i, character: 0 },
            end: { line: i + 1, character: 0 }
        });

        const trimmedLine = lineText.trim();
        if (trimmedLine.startsWith(';')) {
            commentLines.unshift(lineText);
            continue;
        }

        // Add a single line of blankspace leniency after the definition or export statement
        const lowercase = trimmedLine.toLowerCase();
        if (i === definitionStart - 1) {
            if (!trimmedLine) continue;

            hasExport = lowercase.startsWith('.export') || lowercase.startsWith('.global');
            if (hasExport) {
                commentLines.unshift(lineText);
                continue;
            }
        } else if (hasExport && i === definitionStart - 2 && !trimmedLine) {
            continue;
        }

        break;
    }

    // Determine leading indentation of definition line
    const definitionLineText = document.getText({
        start: { line: definitionStart, character: 0 },
        end: { line: definitionStart + 1, character: 0 }
    });
    const definitionIndentMatch = definitionLineText.match(/^\s*/);
    const definitionIndent = definitionIndentMatch ? definitionIndentMatch[0] : '';

    // Collect all lines in the symbol's range
    const contentLines: string[] = [];
    contentLines.push(definitionLineText.trim());
    let shouldShowContent;
    switch (getLSPSymbolKind(entity)) {
        case SymbolKind.Array:
        case SymbolKind.Variable:
        case SymbolKind.Constant:
        case SymbolKind.String:
            shouldShowContent = true;
    }
    if (entity instanceof Macro) {
        shouldShowContent = true;
    }
    if (shouldShowContent) {
        for (let i = definitionStart + 1; i <= rangeEnd; i++) {
            const lineText = document.getText({
                start: { line: i, character: 0 },
                end: { line: i + 1, character: 0 }
            });
    
            // Remove leading spaces matching the definition line's indent
            const normalizedLine = lineText.startsWith(definitionIndent)
                ? lineText.slice(definitionIndent.length)
                : lineText;
            contentLines.push(normalizedLine);
        }
    }

    let content = '';
    if (entity.segment) {
        content += `.segment "${entity.segment}"\n`;
    }

    let currentScope = entity.scope;
    while (currentScope && currentScope.name !== '') {
        content += `.${currentScope.kind} ${currentScope.name}\n`;
        currentScope = currentScope.scope
    }

    if (commentLines.length > 0) {
        content += commentLines.map(line => line.trim()).join('\n') + '\n';
    }

    content += contentLines.map(line => line.trimEnd()).join('\n');

    return '```ca65\n' + content + '\n```';
}

function generateDirectiveHoverMarkdown(directiveName: string, data: any): string {
    let markdown = `### \`${directiveName.toUpperCase()}\`\n`;
    markdown += `${data.shortDescription}\n\n`;
    if (data.documentationUrl) {
        markdown += `[View full documentation](${data.documentationUrl})\n`;
    }
    return markdown;
}

function generateMnemonicHoverMarkdown(mnemonic: string, data: any): string {
    let markdown = `### \`${mnemonic.toUpperCase()}\` - ${data.fullName}\n\n`;
    if (data.description) markdown += `${data.description}\n\n`;
    if (data.warning) markdown += `⚠️ **Warning**: ${data.warning}\n\n`;
    if (data.note) markdown += `*Note: ${data.note}*\n\n`;
    if (data.flags && Object.keys(data.flags).length > 0) {
        markdown += `**Flags affected:**\n`;
        for (const flag in data.flags) {
            markdown += `- **\`${flag}\`**: ${data.flags[flag].description}\n`;
        }
        markdown += `\n`;
    }
    if (data.modes && Object.keys(data.modes).length > 0) {
        markdown += `**Modes:** ${Object.keys(data.modes).join(' | ')}\n\n`;
    }
    return markdown;
}
