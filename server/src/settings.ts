export interface Ca65Settings {
    enableCa65StdErrDiagnostics: boolean;
    executablePath: string;
    enableUnusedSymbolDiagnostics: boolean;
    includeDirs: string[];
    binIncludeDirs: string[];
    autoIncludeExtensions: string[];
    anonymousLabelIndexHints: boolean;
    importFromHints: boolean;
    additionalExtensions: string[];
    smartFolding: boolean;
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
