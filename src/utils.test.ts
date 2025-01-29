import { describe, it, expect } from "vitest";
import { getWebUrl } from "./utils";

describe("getWebUrl", () => {
	it("converts API URLs to web URLs", () => {
		const notification = {
			subject: {
				url: "https://api.github.com/repos/owner/repo/issues/123",
			},
		};

		expect(getWebUrl(notification)).toBe(
			"https://github.com/owner/repo/issues/123",
		);
	});

	it("converts pull request API URLs to web URLs", () => {
		const notification = {
			subject: {
				url: "https://api.github.com/repos/owner/repo/pulls/123",
			},
		};

		expect(getWebUrl(notification)).toBe(
			"https://github.com/owner/repo/pull/123",
		);
	});

	it("handles URLs with trailing parts", () => {
		const notification = {
			subject: {
				url: "https://api.github.com/repos/owner/repo/issues/123/comments",
			},
		};

		expect(getWebUrl(notification)).toBe(
			"https://github.com/owner/repo/issues/123",
		);
	});
});
