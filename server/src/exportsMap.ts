import { Export } from "./symbolTable";

export class ExportsMap {
    /** Per-URI export maps */
    private perUri: Map<string, Map<string, Export>> = new Map();

    /** Global view: baseName -> stack of exports */
    private global: Map<string, Export[]> = new Map();

    /**
     * Update the exports for a given URI.
     * Replaces the old exports from that URI with the new set.
     */
    updateExports(uri: string, newExports: Export[]): void {
        // Remove old exports from this URI
        const oldMap = this.perUri.get(uri);
        if (oldMap) {
            for (const [baseName, exp] of oldMap) {
                this.removeFromGlobal(baseName, exp);
            }
        }

        // Build new per-URI map
        const newMap = new Map<string, Export>();
        for (const exp of newExports) {
            newMap.set(exp.name, exp);
            this.addToGlobal(exp.name, exp);
        }
        this.perUri.set(uri, newMap);
    }

    /**
     * Remove all exports for a given URI.
     */
    removeUri(uri: string): void {
        const oldMap = this.perUri.get(uri);
        if (!oldMap) return;

        for (const [baseName, exp] of oldMap) {
            this.removeFromGlobal(baseName, exp);
        }
        this.perUri.delete(uri);
    }

    /**
     * Get the "active" list of exports by base name.
     */
    get(baseName: string): Export[] {
        const exports = this.global.get(baseName);
        return exports ? exports : [];
    }

    /**
     * Return all currently active exports (deduped by base name).
     */
    getAll(): Export[] {
        const results: Export[] = [];
        for (const stack of this.global.values()) {
            if (stack.length > 0) results.push(stack[stack.length - 1]);
        }
        return results;
    }

    // --- Internals ---

    private addToGlobal(baseName: string, exp: Export) {
        let stack = this.global.get(baseName);
        if (!stack) {
            stack = [];
            this.global.set(baseName, stack);
        }
        stack.push(exp);
    }

    private removeFromGlobal(baseName: string, exp: Export) {
        const stack = this.global.get(baseName);
        if (!stack) return;
        const idx = stack.lastIndexOf(exp);
        if (idx >= 0) stack.splice(idx, 1);
        if (stack.length === 0) {
            this.global.delete(baseName);
        }
    }

    dump() {
        console.log("\n--- Exports Map Dump ---");
        for (const [baseName, stack] of this.global) {
            if (stack.length === 0) continue;
            console.log(`* ${baseName}:`);
            for (let i = stack.length - 1; i >= 0; i--) {
                const exp = stack[i];
                console.log(`    - ${exp.name} (URI: ${exp.uri}, line ${exp.definition.start.line})`);
            }
        }
    }
}
