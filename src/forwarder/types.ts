import type { RestEndpointMethodTypes } from "@octokit/rest";

export type GitHubNotification =
	RestEndpointMethodTypes["activity"]["listNotificationsForAuthenticatedUser"]["response"]["data"][0];

export interface ForwarderConfig {
	githubToken: string;
	crossNotifierUrl: string;
	crossNotifierSecret: string;
	pollIntervalSeconds: number;
	source: string;
}

export interface CrossNotifierPayload {
	source: string;
	title: string;
	message: string;
	status: "info" | "success" | "warning" | "error";
	iconHref?: string;
	duration?: number;
	actions?: Array<{
		label: string;
		url: string;
		open: boolean;
	}>;
}
