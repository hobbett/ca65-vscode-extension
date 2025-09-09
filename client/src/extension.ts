import * as path from 'path';
import {
	workspace,
	ExtensionContext,
	commands,
} from "vscode";
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Uri } from 'vscode';


let client: LanguageClient;

export function activate(context: ExtensionContext) {
	// ADDED: Log to confirm the extension is activating
	console.log('Activating ca65 extension...');

	// --- Start the Language Server ---
	let serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] },
		},
	};

	// Watch files that match the defined language extensions
	const langContribution = context.extension.packageJSON.contributes.languages.find(
        (lang: any) => lang.id === 'ca65'
    );
    const extensions = langContribution?.extensions?.map(
        (ext: string) => ext.substring(1)
    ) || ['s', 'asm', 'inc'];
    const fileWatcherPattern = `**/*.{${extensions.join(',')}}`;

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'ca65' }],
		synchronize: {
			configurationSection: 'ca65',
			fileEvents: workspace.createFileSystemWatcher(fileWatcherPattern)
		},
	};

	client = new LanguageClient(
		'ca65LanguageServer',
		'ca65 Language Server',
		serverOptions,
		clientOptions
	);

	client.start();
	console.log('ca65 Language Client started.');

	// --- Register the "Show Reference" Command ---
	const disposable = commands.registerCommand('ca65.showReference', (mnemonicId?: string) => {
		showReferencePanel(context, mnemonicId);
	});
	context.subscriptions.push(disposable);

	context.subscriptions.push(commands.registerCommand('ca65.dumpPerformanceStats', () => {
		if (client) {
			client.sendRequest('ca65/dumpPerformanceStats');
		}
	}));

	context.subscriptions.push(commands.registerCommand('ca65.dumpSymbolTables', () => {
		if (client) {
			client.sendRequest('ca65/dumpSymbolTables');
		}
	}));

	context.subscriptions.push(commands.registerCommand('ca65.dumpIncludesGraph', () => {
		if (client) {
			client.sendRequest('ca65/dumpIncludesGraph');
		}
	}));

	context.subscriptions.push(commands.registerCommand('ca65.dumpExportsMap', () => {
		if (client) {
			client.sendRequest('ca65/dumpExportsMap');
		}
	}));
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

// --- Implementation for the "Show Reference" Panel ---
async function showReferencePanel(context: ExtensionContext, mnemonicId?: string) {
	// 1. Load the JSON data
	const dataPath = context.asAbsolutePath(path.join('server', 'data', '6502_mnemonics.json'));
	const rawData = await fs.readFile(dataPath, 'utf8');
	const jsonData = JSON.parse(rawData);

	// 2. Generate the full Markdown string
	const fullMarkdown = generateFullMarkdown(jsonData);

	// Save to a temp file
	const tmpDir = os.tmpdir();
	const filePath = path.join(tmpDir, `ca65-reference-${Date.now()}.md`);
	await fs.writeFile(filePath, fullMarkdown, 'utf-8');
	const fileUri = Uri.file(filePath);

	// Show the preview (no editor tab)
	await commands.executeCommand('markdown.showPreviewToSide', fileUri);
}

const FLAG_NAMES: Record<string, string> = {
	N: "Negative",
	V: "Overflow",
	B: "Break",
	D: "Decimal",
	I: "Interrupt",
	Z: "Zero",
	C: "Carry"
};

function generateTypeTable(): string {
	const link = (mnemonic: string) => `[${mnemonic}](#${mnemonic.toLowerCase()})`;

	return `
| Type      | Instructions                                                                 |
|-----------|------------------------------------------------------------------------------|
| Access    | ${link('LDA')}, ${link('STA')}, ${link('LDX')}, ${link('STX')}, ${link('LDY')}, ${link('STY')}                                                 |
| Transfer  | ${link('TAX')}, ${link('TXA')}, ${link('TAY')}, ${link('TYA')}                                                           |
| Arithmetic| ${link('ADC')}, ${link('SBC')}, ${link('INC')}, ${link('DEC')}, ${link('INX')}, ${link('DEX')}, ${link('INY')}, ${link('DEY')}                                       |
| Shift     | ${link('ASL')}, ${link('LSR')}, ${link('ROL')}, ${link('ROR')}                                                           |
| Bitwise   | ${link('AND')}, ${link('ORA')}, ${link('EOR')}, ${link('BIT')}                                                           |
| Compare   | ${link('CMP')}, ${link('CPX')}, ${link('CPY')}                                                                |
| Branch    | ${link('BCC')}, ${link('BCS')}, ${link('BEQ')}, ${link('BNE')}, ${link('BPL')}, ${link('BMI')}, ${link('BVC')}, ${link('BVS')}                                       |
| Jump      | ${link('JMP')}, ${link('JSR')}, ${link('RTS')}, ${link('BRK')}, ${link('RTI')}                                                      |
| Stack     | ${link('PHA')}, ${link('PLA')}, ${link('PHP')}, ${link('PLP')}, ${link('TXS')}, ${link('TSX')}                                                 |
| Flags     | ${link('CLC')}, ${link('SEC')}, ${link('CLI')}, ${link('SEI')}, ${link('CLD')}, ${link('SED')}, ${link('CLV')}                                            |
| Other     | ${link('NOP')}                                                                          |
\n`;
}

// --- Helper to Generate the Full Markdown Reference ---
function generateFullMarkdown(jsonData: any): string {
	let fullMarkdown = "# Instruction reference\n\n";
	fullMarkdown += "## Official instructions by type\n\n";
	fullMarkdown += generateTypeTable();
	fullMarkdown += "\n___\n\n";

	fullMarkdown += "## Official instructions\n\n";

	for (const mnemonic in jsonData) {
		const data = jsonData[mnemonic];

		// Title
		fullMarkdown += `### <a id="${mnemonic.toLowerCase()}"></a>\`${mnemonic}\` - ${data.fullName || ''}\n\n`;

		// Description
		if (data.description) {
			fullMarkdown += `${data.description}\n\n`;
		}

		// Warning
		if (data.warning) {
			fullMarkdown += `⚠️ **WARNING**: ${data.warning}\n\n`;
		}

		if (data.note) {
			fullMarkdown += `*Note: ${data.note}*\n\n`;
		}

		// Flags
		if (data.flagChanges && Object.keys(data.flagChanges).length > 0) {
			fullMarkdown += `| Flag | New Value |\n`;
			fullMarkdown += `|------|-----------|\n`;
			for (const flag of Object.keys(data.flagChanges)) {
				const name = FLAG_NAMES[flag] || flag;
				fullMarkdown += `| \`${flag}\` - ${name} | ${data.flagChanges[flag]} |\n`;
			}
			fullMarkdown += `\n`;
		}

		// Addressing Modes Table
		if (data.modes && Object.keys(data.modes).length > 0) {
			fullMarkdown += `| Addressing Mode | Opcode | Bytes | Cycles |\n`;
			fullMarkdown += `|------|--------|-------|--------|\n`;
			for (const modeName of Object.keys(data.modes)) {
				const mode = data.modes[modeName];
				let cycles = mode.cycles !== undefined ? `${mode.cycles}` : '';
				let notes: string[] = [];
				if (mode.branchPenalty) notes.push("+1 if branch taken");
				if (mode.pagePenalty) notes.push("+1 if page boundary crossed");
				if (notes.length > 0) cycles += ` (${notes.join(", ")})`;
				fullMarkdown += `| ${modeName} | \`${mode.opcode}\` | ${mode.bytes || ''} | ${cycles} |\n`;
			}
			fullMarkdown += `\n`;
		}

		// See also
		if (data.see_also && Array.isArray(data.see_also) && data.see_also.length > 0) {
			const seeAlsoLinks = data.see_also.map(
				(link: string) => `[${link}](#${link.toLowerCase()})`
			).join(', ');
			fullMarkdown += `**See also:** ${seeAlsoLinks}\n\n`;
		}

		fullMarkdown += "---\n\n";
	}
	return fullMarkdown;
}

