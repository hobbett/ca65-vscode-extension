import * as path from 'path';
import { fileURLToPath } from "url";
import { URI } from 'vscode-uri';
import { symbolTables, workspaceFolderUris } from './server';
import { globSync } from 'glob';
import * as fs from 'fs/promises';

export function getRelativePath(fromUri: string, toUri: string): string {
    const fromPath = path.dirname(fileURLToPath(fromUri));
    const toPath = fileURLToPath(toUri);

    return path.relative(fromPath, toPath);
}

export function getWorkspaceRelativePath(fileUri: string): string | null {
    const workspaceFolderUri = getWorkspaceFolderOfFile(fileUri);
    if (!workspaceFolderUri) return null;

    const workspaceRoot = URI.parse(workspaceFolderUri).fsPath;
    const filePath = URI.parse(fileUri).fsPath;

    return path.relative(workspaceRoot, filePath);
}

export function getWorkspaceFolderOfFile(fileUri: string): string | undefined {
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
    if (!workspaceFolderUri || !relativeDirs) return [];

    const workspaceRoot = URI.parse(workspaceFolderUri).fsPath;
    const resolvedPaths: string[] = [];

    for (const dirPattern of relativeDirs) {
        const expandedDirs = globSync(dirPattern, {
            cwd: workspaceRoot,
            absolute: true,
            nodir: false
        });
        resolvedPaths.push(...expandedDirs);
    }
    
    return resolvedPaths;
}

export async function resolveIncludeUri(
    currentFileUri: string,
    includeFile: string,
    includeDirs: string[] | undefined,
): Promise<string | null> {
    const currentDir = path.dirname(URI.parse(currentFileUri).fsPath);
    const resolvedIncludeDirs = resolveWorkspaceRelativeDirs(currentFileUri, includeDirs);
    const directoriesToSearch = [currentDir, ...resolvedIncludeDirs];

    for (const dir of directoriesToSearch) {
        const fullPath = path.join(dir, includeFile);
        const uri = URI.parse(fullPath).toString();
        if (symbolTables.has(uri)) {
            return uri
        }

        try {
            await fs.access(fullPath);
            return uri;
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
        const resolvedUri = await resolveIncludeUri(currentFileUri, candidate, includeDirs);
        if (resolvedUri && resolvedUri === URI.parse(importFileUri).fsPath) {
            return candidate; // Found canonical relative path
        }
    }

    return path.relative(currentDir, importFsPath);
}
