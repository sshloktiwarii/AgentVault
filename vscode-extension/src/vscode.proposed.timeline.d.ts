import * as vscode from 'vscode';

declare module 'vscode' {
    export interface TimelineProvider {
        id: string;
        label: string;
        onDidChange?: vscode.Event<TimelineChangeEvent | undefined>;
        provideTimeline(
            uri: vscode.Uri,
            options: TimelineOptions,
            token: vscode.CancellationToken
        ): vscode.ProviderResult<Timeline>;
    }

    export interface Timeline {
        items: TimelineItem[];
        paging?: {
            cursor?: string;
        };
    }

    export interface TimelineChangeEvent {
        uri?: vscode.Uri;
        reset?: boolean;
    }

    export interface TimelineOptions {
        cursor?: string;
        limit?: number;
        timestamp?: number;
    }

    export class TimelineItem {
        id?: string;
        label: string;
        timestamp: number;
        description?: string;
        detail?: string;
        iconPath?: vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon;
        contextValue?: string;
        command?: vscode.Command;

        constructor(label: string, timestamp: number);
    }

    export namespace workspace {
        export function registerTimelineProvider(
            scheme: string | string[],
            provider: TimelineProvider
        ): vscode.Disposable;
    }
}
