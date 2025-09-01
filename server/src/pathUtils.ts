import * as path from 'path';
import { fileURLToPath } from "url";
import * as fs from 'fs/promises';
import { URI } from 'vscode-uri';
import { workspaceFolderUris } from './server';

export function getRelativePath(fromUri: string, toUri: string): string {
    const fromPath = path.dirname(fileURLToPath(fromUri));
    const toPath = fileURLToPath(toUri);

    return path.relative(fromPath, toPath);
}

function getWorkspaceFolderOfFile(fileUri: string): string | undefined {
    // Find the workspace folder that this file is inside of.
    // Sort by length to find the most specific (deepest) match first in case of nested folders.
    const sortedFolders = workspaceFolderUris
        .filter(folder => fileUri.startsWith(folder))
        .sort((a, b) => b.length - a.length);

    return sortedFolders.length > 0 ? sortedFolders[0] : undefined;
}

export function resolveWorkspaceRelativeDirs(
    currentFileUri: string,
    relativeDirs: string[] | undefined
): string[] {
    const workspaceFolderUri = getWorkspaceFolderOfFile(currentFileUri);
    if (!workspaceFolderUri) return [];

    const workspaceRoot = URI.parse(workspaceFolderUri).fsPath;
    return relativeDirs?.map(p => path.resolve(workspaceRoot, p)) ?? [];
}

export async function resolveIncludePath(
    currentFileUri: string,
    includeFile: string,
    includeDirs: string[] | undefined,
): Promise<string | null> {
    const currentDir = path.dirname(URI.parse(currentFileUri).fsPath);
    const resolvedIncludeDirs = resolveWorkspaceRelativeDirs(currentFileUri, includeDirs);
    const directoriesToSearch = [currentDir, ...resolvedIncludeDirs];

    for (const dir of directoriesToSearch) {
        const fullPath = path.join(dir, includeFile);
        try {
            await fs.access(fullPath);
            return fullPath;
        } catch {}
    }

    return null;
}

export async function findCanonicalIncludePath(
    currentFileUri: string,
    importFileUri: string,
    includeDirs: string[] | undefined,
): Promise<string> {
    const currentDir = path.dirname(URI.parse(currentFileUri).fsPath);
    const importFsPath = URI.parse(importFileUri).fsPath;

    const candidates: string[] = [];

    // Current file directory
    candidates.push(path.relative(currentDir, importFsPath));

    // From include dirs
    const resolvedIncludeDirs = resolveWorkspaceRelativeDirs(currentFileUri, includeDirs);
    for (const incDir of resolvedIncludeDirs) {
        const relPath = path.relative(incDir, importFsPath);
        candidates.push(relPath);
    }

    candidates.sort((a, b) => {
        const aBack = a.includes('..') ? 1 : 0;
        const bBack = b.includes('..') ? 1 : 0;
        if (aBack !== bBack) return aBack - bBack;
        return a.length - b.length;
    });

    for (const candidate of candidates) {
        const resolved = await resolveIncludePath(currentFileUri, candidate, includeDirs);
        if (resolved && URI.file(resolved).fsPath === URI.parse(importFileUri).fsPath) {
            return candidate; // Found canonical relative path
        }
    }

    return path.relative(currentDir, importFsPath);
}
