import { Octokit } from "@octokit/rest";
import { fetchNewNotifications } from "./github.ts";
import { sendNotification } from "./notifier.ts";
import { mapNotification } from "./mapper.ts";
import type { ForwarderConfig } from "./types.ts";

function loadConfig(): ForwarderConfig {
	const githubToken = process.env.GITHUB_TOKEN;
	const crossNotifierUrl = process.env.CROSS_NOTIFIER_URL;
	const crossNotifierSecret = process.env.CROSS_NOTIFIER_SECRET;
	const pollIntervalSeconds =
		Number(process.env.POLL_INTERVAL_SECONDS) || 60;
	const source = process.env.NOTIFIER_SOURCE || "github";

	if (!githubToken) throw new Error("GITHUB_TOKEN is required");
	if (!crossNotifierUrl) throw new Error("CROSS_NOTIFIER_URL is required");
	if (!crossNotifierSecret)
		throw new Error("CROSS_NOTIFIER_SECRET is required");

	return {
		githubToken,
		crossNotifierUrl,
		crossNotifierSecret,
		pollIntervalSeconds,
		source,
	};
}

async function main() {
	const config = loadConfig();
	const octokit = new Octokit({ auth: config.githubToken });

	const forwarded = new Set<string>();
	let since = new Date().toISOString();

	console.log(
		`[forwarder] Starting. Polling every ${config.pollIntervalSeconds}s`,
	);
	console.log(`[forwarder] Target: ${config.crossNotifierUrl}`);
	console.log(`[forwarder] Source: ${config.source}`);

	const poll = async () => {
		try {
			const { notifications, fetchedAt } = await fetchNewNotifications(
				octokit,
				since,
			);

			const newNotifications = notifications.filter(
				(n) => !forwarded.has(n.id),
			);

			if (newNotifications.length > 0) {
				console.log(
					`[forwarder] ${newNotifications.length} new notification(s)`,
				);
			}

			for (const notification of newNotifications) {
				try {
					const payload = mapNotification(notification, config.source);
					await sendNotification(
						config.crossNotifierUrl,
						config.crossNotifierSecret,
						payload,
					);
					forwarded.add(notification.id);
					console.log(
						`[forwarder] Forwarded: ${notification.subject.title}`,
					);
				} catch (err) {
					console.error(
						`[forwarder] Failed to forward "${notification.subject.title}":`,
						err,
					);
				}
			}

			since = fetchedAt;

			// Prune forwarded set to prevent unbounded growth
			if (forwarded.size > 10_000) {
				const currentIds = new Set(notifications.map((n) => n.id));
				for (const id of forwarded) {
					if (!currentIds.has(id)) forwarded.delete(id);
				}
			}
		} catch (err) {
			console.error("[forwarder] Poll error:", err);
		}
	};

	await poll();
	setInterval(poll, config.pollIntervalSeconds * 1000);
}

main().catch((err) => {
	console.error("[forwarder] Fatal:", err);
	process.exit(1);
});
