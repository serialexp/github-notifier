interface GitHubNotification {
	subject: {
		url: string;
	};
}

export const getWebUrl = (notification: GitHubNotification): string => {
	// The API URL format is: https://api.github.com/repos/owner/repo/[issues|pulls]/number
	// We need to transform it to: https://github.com/owner/repo/[issues|pull]/number
	const url = notification.subject.url;
	const htmlUrl = url
		.replace("api.github.com/repos", "github.com")
		.replace("pulls", "pull");

	// Remove any trailing API-specific parts (like /comments, etc)
	return htmlUrl.replace(/\/(comments|reviews|review_comments)$/, "");
};
