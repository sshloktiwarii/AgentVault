import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const provider = new AgentVaultTimelineProvider();
    context.subscriptions.push(vscode.workspace.registerTimelineProvider('agentvault-timeline', provider));

    context.subscriptions.push(vscode.commands.registerCommand('agentvault.restore', async (item: vscode.TimelineItem) => {
        if (!item.id) return;
        const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!cwd) return;

        const selection = await vscode.window.showWarningMessage(
            `Restore to AgentVault Checkpoint #${item.id}? This will safely roll back newer agent mutations.`,
            'Restore', 'Cancel'
        );

        if (selection === 'Restore') {
            try {
                await execAsync(`agentvault undo ${item.id} --force`, { cwd });
                vscode.window.showInformationMessage(`✅ Restored to Checkpoint #${item.id}`);
                provider.refresh();
            } catch (error: any) {
                vscode.window.showErrorMessage(`AgentVault Restore Failed: ${error.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('agentvault.refresh', () => provider.refresh()));
}

class AgentVaultTimelineProvider implements vscode.TimelineProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.TimelineChangeEvent | undefined>();
    public readonly onDidChange = this._onDidChange.event;
    public readonly id = 'agentvault-timeline';
    public readonly label = 'AgentVault Recovery';

    public refresh() { this._onDidChange.fire(undefined); }

    async provideTimeline(uri: vscode.Uri, options: vscode.TimelineOptions, token: vscode.CancellationToken): Promise<vscode.Timeline | undefined> {
        const cwd = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!cwd) return undefined;

        try {
            const { stdout } = await execAsync('agentvault status --json', { cwd });
            const checkpoints = JSON.parse(stdout);

            const items: vscode.TimelineItem[] = checkpoints.map((cp: any) => {
                const item = new vscode.TimelineItem(`Checkpoint #${cp.id}`, new Date(cp.created_at).getTime());
                item.id = cp.id.toString();
                item.description = `${cp.files_mutated} files mutated (${cp.trigger_type})`;
                item.iconPath = new vscode.ThemeIcon('history');
                item.contextValue = 'agentvaultCheckpoint';
                item.command = { title: "Restore", command: "agentvault.restore", arguments: [item] };
                return item;
            });
            return { items };
        } catch (error) {
            console.error("AgentVault fetch failed", error);
            return undefined;
        }
    }
}
