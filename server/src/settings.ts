export interface Ca65Settings {
    executablePath: string;
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
