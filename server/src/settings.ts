export interface Ca65Settings {
    executablePath: string;
    includeDirs: string[];
    binIncludeDirs: string[];
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
