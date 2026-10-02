import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CheckpointEntry {
    id: number;
    session_id: string;
    git_commit_hash: string;
    trigger_type: string;
    timestamp: number;
}

interface GhostBranchStatus {
    repo_root: string;
    repo_identity: string;
    store_path: string;
    cas_size_bytes: number;
    latest_checkpoint: CheckpointEntry | null;
    checkpoints: CheckpointEntry[];
}

export class GhostBranchTimelineProvider implements vscode.TimelineProvider {
    readonly id = 'ghostbranch-timeline';
    readonly label = 'GhostBranch Recovery';

    private _onDidChange = new vscode.EventEmitter<vscode.TimelineChangeEvent>();
    readonly onDidChange = this._onDidChange.event;

    refresh(): void {
        this._onDidChange.fire({ reset: true });
    }

    async provideTimeline(
        _uri: vscode.Uri,
        _options: vscode.TimelineOptions,
        _token: vscode.CancellationToken
    ): Promise<vscode.Timeline> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { items: [] };
        }

        const cwd = workspaceFolders[0].uri.fsPath;

        try {
            const { stdout } = await execAsync('ghostbranch status --json', { cwd });
            const status: GhostBranchStatus = JSON.parse(stdout);

            const items: vscode.TimelineItem[] = (status.checkpoints || []).map((cp) => {
                const date = new Date(cp.timestamp * 1000);
                const shortCommit = cp.git_commit_hash.substring(0, 8);
                const item = new vscode.TimelineItem(
                    `Checkpoint #${cp.id}: ${cp.trigger_type}`,
                    date.getTime()
                );

                item.description = `Tree: ${shortCommit} | Session: ${cp.session_id.substring(0, 8)}`;
                item.detail = `Trigger: ${cp.trigger_type}\nCommit: ${cp.git_commit_hash}\nTime: ${date.toLocaleString()}`;
                item.iconPath = new vscode.ThemeIcon('history');
                item.contextValue = 'ghostbranchCheckpoint';

                // Command attached to restore to this checkpoint
                item.command = {
                    command: 'ghostbranch.restore',
                    title: 'Restore Checkpoint',
                    arguments: [cp.id]
                };

                return item;
            });

            // Sort newest first
            items.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

            return { items };
        } catch (err: any) {
            console.error('Failed to query GhostBranch timeline:', err);
            return { items: [] };
        }
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const timelineProvider = new GhostBranchTimelineProvider();

    // Register Timeline Provider
    context.subscriptions.push(
        vscode.workspace.registerTimelineProvider('ghostbranch-timeline', timelineProvider)
    );

    // Register Refresh Command
    context.subscriptions.push(
        vscode.commands.registerCommand('ghostbranch.refreshTimeline', () => {
            timelineProvider.refresh();
        })
    );

    // Register Restore Command
    context.subscriptions.push(
        vscode.commands.registerCommand('ghostbranch.restore', async (checkpointId?: number) => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showErrorMessage('No active workspace folder to execute GhostBranch restore.');
                return;
            }

            const targetId = checkpointId ?? await (async () => {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter Checkpoint ID or number of steps to rollback',
                    placeHolder: '1'
                });
                return input ? parseInt(input, 10) : undefined;
            })();

            if (targetId === undefined || isNaN(targetId)) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to rollback to checkpoint #${targetId}? Uncommitted human edits will be overwritten if conflicting.`,
                { modal: true },
                'Rollback & Restore'
            );

            if (confirm !== 'Rollback & Restore') {
                return;
            }

            const cwd = workspaceFolders[0].uri.fsPath;

            try {
                const { stdout, stderr } = await execAsync(`ghostbranch undo ${targetId} --force`, { cwd });
                vscode.window.showInformationMessage(`GhostBranch: Restored checkpoint #${targetId} successfully.`);
                timelineProvider.refresh();
                if (stdout) {
                    console.log(stdout);
                }
                if (stderr) {
                    console.warn(stderr);
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`GhostBranch rollback failed: ${err.message || err}`);
            }
        })
    );
}

export function deactivate(): void {}
