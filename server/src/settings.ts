export interface Ca65Settings {
    executablePath: string;
    includeDirs: string[];
    binIncludeDirs: string[];
    autoIncludeExtensions: string[];
    anonymousLabelIndexHints: boolean;
    importFromHints: boolean;
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
