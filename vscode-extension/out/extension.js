"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GhostBranchTimelineProvider = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class GhostBranchTimelineProvider {
    id = 'ghostbranch-timeline';
    label = 'GhostBranch Recovery';
    _onDidChange = new vscode.EventEmitter();
    onDidChange = this._onDidChange.event;
    refresh() {
        this._onDidChange.fire({ reset: true });
    }
    async provideTimeline(_uri, _options, _token) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { items: [] };
        }
        const cwd = workspaceFolders[0].uri.fsPath;
        try {
            const { stdout } = await execAsync('ghostbranch status --json', { cwd });
            const status = JSON.parse(stdout);
            const items = (status.checkpoints || []).map((cp) => {
                const date = new Date(cp.timestamp * 1000);
                const shortCommit = cp.git_commit_hash.substring(0, 8);
                const item = new vscode.TimelineItem(`Checkpoint #${cp.id}: ${cp.trigger_type}`, date.getTime());
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
        }
        catch (err) {
            console.error('Failed to query GhostBranch timeline:', err);
            return { items: [] };
        }
    }
}
exports.GhostBranchTimelineProvider = GhostBranchTimelineProvider;
function activate(context) {
    const timelineProvider = new GhostBranchTimelineProvider();
    // Register Timeline Provider
    context.subscriptions.push(vscode.workspace.registerTimelineProvider('ghostbranch-timeline', timelineProvider));
    // Register Refresh Command
    context.subscriptions.push(vscode.commands.registerCommand('ghostbranch.refreshTimeline', () => {
        timelineProvider.refresh();
    }));
    // Register Restore Command
    context.subscriptions.push(vscode.commands.registerCommand('ghostbranch.restore', async (checkpointId) => {
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
        const confirm = await vscode.window.showWarningMessage(`Are you sure you want to rollback to checkpoint #${targetId}? Uncommitted human edits will be overwritten if conflicting.`, { modal: true }, 'Rollback & Restore');
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
        }
        catch (err) {
            vscode.window.showErrorMessage(`GhostBranch rollback failed: ${err.message || err}`);
        }
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map