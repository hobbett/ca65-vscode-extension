import {
    _Connection,
    DocumentLinkParams,
    DocumentLink,
    TextDocuments,
    Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';

export function initializeDocumentLinkProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] | undefined => {
        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return undefined;
        }

        const links: DocumentLink[] = [];
        const includeRegex = /^\s*\.(include|incbin)\s+"([^"]+)"/i;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.getText({
                start: { line: i, character: 0 },
                end: { line: i + 1, character: 0}
            });
            const match = line.match(includeRegex);

            if (match) {
                const filename = match[2];
                const startChar = line.indexOf(filename);
                const endChar = startChar + filename.length;

                // Create a range for just the filename part
                const range = Range.create(i, startChar, i, endChar);

                // Resolve the full path of the included file
                const currentDocPath = URI.parse(document.uri).fsPath;
                const currentDocDir = path.dirname(currentDocPath);
                const targetPath = path.resolve(currentDocDir, filename);
                const targetUri = URI.file(targetPath).toString();

                links.push({
                    range: range,
                    target: targetUri,
                    tooltip: `Click to open ${filename}`
                });
            }
        }
        return links;
    });
}
