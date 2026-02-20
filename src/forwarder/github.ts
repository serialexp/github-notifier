import type { Octokit } from "@octokit/rest";
import type { GitHubNotification } from "./types.ts";

export async function fetchNewNotifications(
	octokit: Octokit,
	since: string,
): Promise<{ notifications: GitHubNotification[]; fetchedAt: string }> {
	const fetchedAt = new Date().toISOString();
	const allNotifications: GitHubNotification[] = [];
	let page = 1;

	while (true) {
		const { data: notifications, headers } =
			await octokit.activity.listNotificationsForAuthenticatedUser({
				all: false,
				participating: false,
				per_page: 100,
				page,
				since,
			});

		if (notifications.length === 0) break;
		allNotifications.push(...notifications);

		const links = headers.link;
		if (!links || !links.includes('rel="next"')) break;
		page++;
	}

	return { notifications: allNotifications, fetchedAt };
}
