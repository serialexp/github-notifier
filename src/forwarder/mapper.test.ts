import { describe, it, expect } from "vitest";
import { mapNotification } from "./mapper";
import type { GitHubNotification } from "./types";

function makeNotification(
	overrides: Partial<{
		reason: string;
		subjectType: string;
		subjectTitle: string;
		subjectUrl: string;
		repoFullName: string;
		ownerLogin: string;
	}> = {},
): GitHubNotification {
	return {
		id: "1",
		reason: overrides.reason ?? "comment",
		subject: {
			title: overrides.subjectTitle ?? "Fix login bug",
			url:
				overrides.subjectUrl ??
				"https://api.github.com/repos/acme/app/issues/42",
			type: overrides.subjectType ?? "Issue",
			latest_comment_url: null,
		},
		repository: {
			full_name: overrides.repoFullName ?? "acme/app",
			owner: {
				login: overrides.ownerLogin ?? "acme",
			},
		} as GitHubNotification["repository"],
		updated_at: "2026-01-15T10:00:00Z",
		unread: true,
		subscription_url: "",
		url: "",
		last_read_at: null,
	} as GitHubNotification;
}

describe("mapNotification", () => {
	it("maps an issue notification", () => {
		const notification = makeNotification({
			reason: "comment",
			subjectType: "Issue",
			subjectTitle: "Fix login bug",
		});

		const payload = mapNotification(notification, "github");

		expect(payload).toEqual({
			source: "github",
			title: "[acme/app] Fix login bug",
			message: "new comment on issue in acme/app",
			status: "info",
			iconHref: "https://github.com/acme.png?size=64",
			duration: 8,
			actions: [
				{
					label: "Open Issue",
					url: "https://github.com/acme/app/issues/42",
					open: true,
				},
			],
		});
	});

	it("maps a pull request notification", () => {
		const notification = makeNotification({
			reason: "review_requested",
			subjectType: "PullRequest",
			subjectTitle: "Add dark mode",
			subjectUrl: "https://api.github.com/repos/acme/app/pulls/99",
		});

		const payload = mapNotification(notification, "github");

		expect(payload.title).toBe("[acme/app] Add dark mode");
		expect(payload.message).toBe("review requested on pull request in acme/app");
		expect(payload.status).toBe("warning");
		expect(payload.actions?.[0]).toEqual({
			label: "Open PR",
			url: "https://github.com/acme/app/pull/99",
			open: true,
		});
	});

	it("maps a discussion notification", () => {
		const notification = makeNotification({
			reason: "subscribed",
			subjectType: "Discussion",
			subjectTitle: "RFC: New API design",
			subjectUrl:
				"https://api.github.com/repos/acme/app/discussions/5",
		});

		const payload = mapNotification(notification, "github");

		expect(payload.title).toBe("[acme/app] RFC: New API design");
		expect(payload.message).toBe("watching on discussion in acme/app");
		expect(payload.status).toBe("info");
		expect(payload.actions?.[0]?.label).toBe("Open");
	});

	it("maps security_alert to error status", () => {
		const notification = makeNotification({ reason: "security_alert" });
		const payload = mapNotification(notification, "github");
		expect(payload.status).toBe("error");
	});

	it("maps assign to warning status", () => {
		const notification = makeNotification({ reason: "assign" });
		expect(mapNotification(notification, "github").status).toBe("warning");
	});

	it("maps mention to warning status", () => {
		const notification = makeNotification({ reason: "mention" });
		expect(mapNotification(notification, "github").status).toBe("warning");
	});

	it("maps team_mention to warning status", () => {
		const notification = makeNotification({ reason: "team_mention" });
		expect(mapNotification(notification, "github").status).toBe("warning");
	});

	it("maps author to success status", () => {
		const notification = makeNotification({ reason: "author" });
		expect(mapNotification(notification, "github").status).toBe("success");
	});

	it("maps state_change to success status", () => {
		const notification = makeNotification({ reason: "state_change" });
		expect(mapNotification(notification, "github").status).toBe("success");
	});

	it("uses repo URL as fallback when subject.url is null", () => {
		const notification = makeNotification({
			subjectUrl: "",
			repoFullName: "acme/infra",
		});
		// Override subject.url to null
		(notification.subject as { url: string | null }).url = null;

		const payload = mapNotification(notification, "github");
		expect(payload.actions?.[0]?.url).toBe("https://github.com/acme/infra");
	});

	it("uses the custom source field", () => {
		const notification = makeNotification();
		const payload = mapNotification(notification, "my-ci");
		expect(payload.source).toBe("my-ci");
	});

	it("uses the owner avatar as icon", () => {
		const notification = makeNotification({ ownerLogin: "serialexp" });
		const payload = mapNotification(notification, "github");
		expect(payload.iconHref).toBe(
			"https://github.com/serialexp.png?size=64",
		);
	});

	it("handles unknown reason gracefully", () => {
		const notification = makeNotification({ reason: "ci_activity" as string });
		const payload = mapNotification(notification, "github");
		expect(payload.message).toContain("ci activity");
		expect(payload.status).toBe("info");
	});
});
