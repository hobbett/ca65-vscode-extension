import * as path from 'path';
import * as fs from 'fs';
import { _Connection } from 'vscode-languageserver/node';

export let mnemonicData: any = {};
export let directiveData: any = {};

export function loadAllData(connection: _Connection) {
    // Load 6502 mnemonics data
    const mnemonicPath = path.join(__dirname, '..', 'src', 'data', '6502_mnemonics.json');
    try {
        mnemonicData = JSON.parse(fs.readFileSync(mnemonicPath, 'utf8'));
        connection.console.log('Successfully loaded 6502 mnemonics data.');
    } catch (error) {
        connection.console.error(`Failed to load mnemonics data: ${error}`);
    }

    // Load ca65 directives data
    const directivePath = path.join(__dirname, '..', 'src', 'data', 'ca65_directives.json');
    try {
        directiveData = JSON.parse(fs.readFileSync(directivePath, 'utf8'));
        connection.console.log('Successfully loaded ca65 directives data.');
    } catch (error) {
        connection.console.error(`Failed to load ca65 directives data: ${error}`);
    }
}
