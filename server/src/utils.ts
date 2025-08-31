import * as path from 'path';
import { fileURLToPath } from "url";

export function getRelativePath(fromUri: string, toUri: string): string {
    const fromPath = path.dirname(fileURLToPath(fromUri));
    const toPath = fileURLToPath(toUri);

    return path.relative(fromPath, toPath);
}
