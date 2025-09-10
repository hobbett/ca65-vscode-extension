import {
    _Connection,
    DocumentLinkParams,
    DocumentLink,
    TextDocuments,
    Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { resolveIncludeUri } from './pathUtils';
import { getDocumentSettings, initializationGate } from './server';

export function initializeDocumentLinkProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onDocumentLinks(async (params: DocumentLinkParams): Promise<DocumentLink[] | undefined> => {
        await initializationGate.isInitialized;

        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return undefined;
        }

        const settings = await getDocumentSettings(document.uri);
        const links: DocumentLink[] = [];
        const includeRegex = /^\s*\.(include|incbin)\s+"([^"]+)"/i;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.getText({
                start: { line: i, character: 0 },
                end: { line: i + 1, character: 0 }
            });
            const match = line.match(includeRegex);

            if (match) {
                const directive = match[1].toLowerCase(); // "include" or "incbin"
                const filename = match[2];

                const startChar = line.indexOf(filename);
                const endChar = startChar + filename.length;
                const range = Range.create(i, startChar, i, endChar);

                let targetUri: string | null = null;
                if (directive === "include") {
                    targetUri = resolveIncludeUri(document.uri, filename, settings.includeDirs);
                } else if (directive === "incbin") {
                    targetUri = resolveIncludeUri(document.uri, filename, settings.binIncludeDirs);
                }

                if (targetUri) {
                    links.push({
                        range,
                        target: targetUri,
                        tooltip: `Click to open ${filename}`
                    });
                }
            }
        }
        return links;
    });
}
