import { getWebUrl } from "../utils.ts";
import type { GitHubNotification, CrossNotifierPayload } from "./types.ts";

function mapReasonToStatus(reason: string): CrossNotifierPayload["status"] {
	switch (reason) {
		case "security_alert":
			return "error";
		case "review_requested":
		case "assign":
		case "mention":
		case "team_mention":
			return "warning";
		case "state_change":
		case "author":
			return "success";
		default:
			return "info";
	}
}

function formatReason(reason: string): string {
	switch (reason) {
		case "assign":
			return "assigned";
		case "author":
			return "you created";
		case "comment":
			return "new comment";
		case "invitation":
			return "invited";
		case "manual":
			return "subscribed";
		case "mention":
			return "mentioned";
		case "review_requested":
			return "review requested";
		case "security_alert":
			return "security alert";
		case "state_change":
			return "state changed";
		case "subscribed":
			return "watching";
		case "team_mention":
			return "team mentioned";
		default:
			return reason.replace(/_/g, " ");
	}
}

function formatSubjectType(type: string): string {
	// "PullRequest" → "pull request", "Issue" → "issue"
	return type.replace(/([A-Z])/g, " $1").trim().toLowerCase();
}

export function shouldForward(
	notification: GitHubNotification,
	excludeOrgs: string[],
	excludeRepos: string[],
): boolean {
	const repo = notification.repository.full_name;
	const org = notification.repository.owner.login;

	if (excludeRepos.includes(repo)) return false;
	if (excludeOrgs.includes(org)) return false;

	return true;
}

export function mapNotification(
	notification: GitHubNotification,
	source: string,
): CrossNotifierPayload {
	const repo = notification.repository.full_name;
	const subjectType = formatSubjectType(notification.subject.type);
	const reason = formatReason(notification.reason);

	const title = `[${repo}] ${notification.subject.title}`;
	const message = `${reason} on ${subjectType} in ${repo}`;

	const webUrl = notification.subject.url
		? getWebUrl(notification)
		: `https://github.com/${repo}`;

	const label =
		notification.subject.type === "PullRequest"
			? "Open PR"
			: notification.subject.type === "Issue"
				? "Open Issue"
				: "Open";

	return {
		source,
		title,
		message,
		status: mapReasonToStatus(notification.reason),
		iconHref: `https://github.com/${notification.repository.owner.login}.png?size=64`,
		duration: 8,
		actions: [
			{
				label,
				url: webUrl,
				open: true,
			},
		],
	};
}
