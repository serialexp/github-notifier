import type { CrossNotifierPayload } from "./types.ts";

export async function sendNotification(
	baseUrl: string,
	secret: string,
	payload: CrossNotifierPayload,
): Promise<void> {
	const url = `${baseUrl.replace(/\/$/, "")}/notify`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${secret}`,
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "<unreadable>");
		throw new Error(
			`cross-notifier responded ${response.status}: ${body}`,
		);
	}
}
