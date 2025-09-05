const WINDOW_SIZE = 100; // Keep the last 100 samples for the running average

interface OperationWindowStats {
    samples: number[];
}

export class Performance {
    private timings: Map<string, OperationWindowStats> = new Map();
    private startTimes: Map<string, number> = new Map();

    public start(name: string): void {
        this.startTimes.set(name, performance.now());
    }

    public stop(name: string): void {
        const startTime = this.startTimes.get(name);
        if (startTime === undefined) {
            return;
        }
        this.startTimes.delete(name);
        const duration = performance.now() - startTime;

        if (!this.timings.has(name)) {
            this.timings.set(name, {
                samples: [],
            });
        }

        const stats = this.timings.get(name)!;
        stats.samples.push(duration);

        // Keep the window size capped by removing the oldest sample.
        if (stats.samples.length > WINDOW_SIZE) {
            stats.samples.shift();
        }
    }

    public getReport(): string {
        let report = '--- LSP Performance Stats (Running Window) ---\n';
        if (this.timings.size === 0) {
            return report + 'No operations have been timed yet.\n';
        }

        const sortedTimings = Array.from(this.timings.entries()).sort(
            (a, b) => a[0].localeCompare(b[0])
        );

        for (const [name, stats] of sortedTimings) {
            const sampleCount = stats.samples.length;
            if (sampleCount === 0) {
                continue;
            }

            const sum = stats.samples.reduce((a, b) => a + b, 0);
            const avg = sum / sampleCount;
            const min = Math.min(...stats.samples);
            const max = Math.max(...stats.samples);
            
            report += `Operation: ${name}\n`;
            report += `  Samples: ${sampleCount} (last ${WINDOW_SIZE})\n`;
            report += `  Min:     ${min.toFixed(2)} ms\n`;
            report += `  Max:     ${max.toFixed(2)} ms\n`;
            report += `  Avg:     ${avg.toFixed(2)} ms\n\n`;
        }
        return report;
    }

    public clear(): void {
        this.timings.clear();
        this.startTimes.clear();
        console.log('Performance stats cleared.');
    }
}
