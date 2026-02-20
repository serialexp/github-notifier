#!/usr/bin/env node --experimental-specifier-resolution=node
// @ts-ignore - Needed for Node.js execution
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, render, useStdout, useInput } from "ink";
import Spinner from "ink-spinner";
import { Octokit } from "@octokit/rest";
import open from "open";
import Conf from "conf";
import TimeAgo from "javascript-time-ago";
import en from "javascript-time-ago/locale/en";
import type { RestEndpointMethodTypes } from "@octokit/rest";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import PQueue from "p-queue";
import { getWebUrl } from "./src/utils";

// Initialize TimeAgo and marked
TimeAgo.addDefaultLocale(en);
const timeAgo = new TimeAgo("en-US");

// Configure marked with terminal renderer
const options = {
	code: chalk.yellow,
	blockquote: chalk.gray.italic,
	heading: chalk.cyan.bold,
	firstHeading: chalk.blue.bold,
	strong: chalk.bold,
	em: chalk.italic,
	codespan: chalk.yellow,
	del: chalk.dim.gray.strikethrough,
	link: chalk.blue,
	href: chalk.blue.underline,
	width: process.stdout.columns - 4,
	reflowText: true,
	unescape: true,
	emoji: true,
};

// @ts-ignore - Types are not perfectly aligned between marked and marked-terminal
marked.use(markedTerminal(options));

const config = new Conf({
	projectName: "github-notifier",
	schema: {
		githubToken: {
			type: "string",
			default: "",
		},
		notifications: {
			type: "array",
			default: [],
		},
		lastFetchTime: {
			type: "string",
			default: new Date(0).toISOString(),
		},
	},
});

type GitHubNotification =
	RestEndpointMethodTypes["activity"]["listNotificationsForAuthenticatedUser"]["response"]["data"][0];

type NotificationGroup = {
	name: string;
	notifications: GitHubNotification[];
	expanded: boolean;
};

interface Item {
	key?: string;
	label: string;
	value: {
		type: "notification" | "group" | "exit" | "back";
		data?: GitHubNotification;
		name?: string;
		notifications?: GitHubNotification[];
	};
	reasonText?: string;
	reasonColor?: string;
	timeText?: string;
	isLoading?: boolean;
	prState?: {
		state: string;
		approved?: boolean;
	};
	isPRStateLoading?: boolean;
}

interface GitHubComment {
	body: string;
	user: {
		login: string;
	};
	created_at: string;
}

interface GitHubEvent {
	id: string;
	event: string;
	actor: {
		login: string;
	};
	created_at: string;
	label?: {
		name: string;
		color: string;
	};
	assignee?: {
		login: string;
	};
	assigner?: {
		login: string;
	};
	review_requester?: {
		login: string;
	};
	requested_reviewer?: {
		login: string;
	};
}

interface TimelineItem {
	type: "comment" | "event";
	data: GitHubComment | GitHubEvent;
	created_at: string;
}

interface GitHubReviewComment {
	path: string;
	line?: number;
	body: string;
	user: {
		login: string;
	};
	created_at: string;
}

interface GitHubDiscussionComment {
	author: {
		login: string;
	};
	body: string;
	createdAt: string;
}

const TokenPrompt = ({ onToken }: { onToken: (token: string) => void }) => {
	const [input, setInput] = useState("");

	useInput((char, key) => {
		if (key.return && input.length > 0) {
			config.set("githubToken", input);
			onToken(input);
		} else if (key.backspace || key.delete) {
			setInput((prev) => prev.slice(0, -1));
		} else if (char && char.length === 1) {
			setInput((prev) => prev + char);
		}
	});

	return (
		<Box flexDirection="column">
			<Text>Enter your GitHub personal access token:</Text>
			<Text>
				{">"} {"*".repeat(input.length)}
			</Text>
		</Box>
	);
};

const formatEvent = (event: GitHubEvent): string => {
	switch (event.event) {
		case "assigned":
			return `@${event.actor.login} assigned @${event.assignee?.login}`;
		case "unassigned":
			return `@${event.actor.login} unassigned @${event.assignee?.login}`;
		case "labeled":
			return `@${event.actor.login} added label ${event.label?.name}`;
		case "unlabeled":
			return `@${event.actor.login} removed label ${event.label?.name}`;
		case "locked":
			return `@${event.actor.login} locked this conversation`;
		case "unlocked":
			return `@${event.actor.login} unlocked this conversation`;
		case "milestoned":
			return `@${event.actor.login} added this to a milestone`;
		case "demilestoned":
			return `@${event.actor.login} removed this from a milestone`;
		case "pinned":
			return `@${event.actor.login} pinned this issue`;
		case "unpinned":
			return `@${event.actor.login} unpinned this issue`;
		case "closed":
			return `@${event.actor.login} closed this`;
		case "reopened":
			return `@${event.actor.login} reopened this`;
		case "review_requested":
			return `@${event.actor.login} requested review from @${event.requested_reviewer?.login}`;
		case "review_request_removed":
			return `@${event.actor.login} removed review request from @${event.requested_reviewer?.login}`;
		default:
			return `@${event.actor.login} ${event.event.replace("_", " ")}`;
	}
};

const NotificationContent = ({
	notification,
	onBack,
}: {
	notification: GitHubNotification;
	onBack: (markAsRead?: boolean) => void;
}) => {
	const [loading, setLoading] = useState(true);
	const [content, setContent] = useState("");
	const [renderedContent, setRenderedContent] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [scrollOffset, setScrollOffset] = useState(0);
	const [isUnsubscribing, setIsUnsubscribing] = useState(false);
	const [isFetchingMoreComments, setIsFetchingMoreComments] = useState(false);
	const [totalComments, setTotalComments] = useState(0);
	const [nextCommentsPage, setNextCommentsPage] = useState<string | null>(null);
	const [averageCommentLines, setAverageCommentLines] = useState(0);
	const [events, setEvents] = useState<GitHubEvent[]>([]);
	const { stdout } = useStdout();
	const maxLines = stdout.rows - 4;

	// Effect to render markdown when content changes
	useEffect(() => {
		try {
			const rendered = marked(content, { async: false });
			setRenderedContent(rendered);
		} catch (err) {
			console.error("Failed to render markdown:", err);
			setRenderedContent(content);
		}
	}, [content]);

	// Helper to calculate average lines per comment
	const calculateAverageLines = useCallback(
		(comments: GitHubComment[]): number => {
			if (comments.length === 0) return 0;
			const totalLines = comments.reduce((sum, comment) => {
				return sum + (comment.body?.split("\n").length || 0);
			}, 0);
			return Math.ceil(totalLines / comments.length);
		},
		[],
	);

	// Main content fetch effect
	useEffect(() => {
		const fetchContent = async () => {
			try {
				const token = config.get("githubToken");
				const headers = {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				};

				// Fetch the main content
				const response = await fetch(notification.subject.url, { headers });
				const data = await response.json();

				let displayContent = "";
				if (data.title) {
					displayContent += `# ${data.title}\n\n`;
				}
				if (data.state) {
					displayContent += `**Status:** ${data.state}\n`;
					if (data.merged) {
						displayContent += "**Status:** Merged\n";
					}
					displayContent += "\n";
				}
				if (data.body) {
					displayContent += "## Description\n\n";
					// Indent each line of the description with two spaces
					displayContent += `${data.body
						.split("\n")
						.map((line: string) => `> ${line}`)
						.join("\n")}\n\n`;
				}

				let allComments: GitHubComment[] = [];
				let allEvents: GitHubEvent[] = [];

				// Fetch all comments based on notification type
				if (notification.subject.type === "PullRequest") {
					// Fetch PR comments (issue comments)
					const prCommentsUrl = data.comments_url;
					// Fetch PR review comments
					const reviewCommentsUrl =
						data._links?.review_comments?.href || data.review_comments_url;

					let page = 1;
					const perPage = 100;

					// Fetch issue comments
					while (true) {
						const commentsUrl = `${prCommentsUrl}?per_page=${perPage}&page=${page}`;
						const commentsResponse = await fetch(commentsUrl, { headers });
						const comments = await commentsResponse.json();

						if (!Array.isArray(comments) || comments.length === 0) break;
						allComments = [...allComments, ...comments];

						if (comments.length < perPage) break;
						page++;
					}

					// Fetch review comments if available
					if (reviewCommentsUrl) {
						page = 1;
						while (true) {
							const reviewCommentsUrl2 = `${reviewCommentsUrl}?per_page=${perPage}&page=${page}`;
							const reviewCommentsResponse = await fetch(reviewCommentsUrl2, {
								headers,
							});
							const reviewComments = await reviewCommentsResponse.json();

							if (!Array.isArray(reviewComments) || reviewComments.length === 0)
								break;

							// Convert review comments to regular comment format
							const formattedReviewComments = reviewComments.map(
								(comment: GitHubReviewComment) => ({
									body: `**Review comment on ${comment.path}${comment.line ? ` line ${comment.line}` : ""}:**\n\n${comment.body}`,
									user: comment.user,
									created_at: comment.created_at,
								}),
							);

							allComments = [...allComments, ...formattedReviewComments];

							if (reviewComments.length < perPage) break;
							page++;
						}
					}
				} else if (notification.subject.type === "Discussion") {
					// Fetch discussion comments using the GraphQL API
					const [owner, repo] = notification.repository.full_name.split("/");
					const discussionNumber = data.number;

					const graphqlQuery = {
						query: `
							query($owner: String!, $repo: String!, $number: Int!) {
								repository(owner: $owner, name: $repo) {
									discussion(number: $number) {
										comments(first: 100) {
											nodes {
												author { login }
												body
												createdAt
											}
										}
									}
								}
							}
						`,
						variables: {
							owner,
							repo,
							number: discussionNumber,
						},
					};

					const graphqlResponse = await fetch(
						"https://api.github.com/graphql",
						{
							method: "POST",
							headers: {
								...headers,
								"Content-Type": "application/json",
							},
							body: JSON.stringify(graphqlQuery),
						},
					);

					const graphqlData = await graphqlResponse.json();
					const discussionComments =
						graphqlData.data?.repository?.discussion?.comments?.nodes || [];

					// Convert discussion comments to regular comment format
					allComments = discussionComments.map(
						(comment: GitHubDiscussionComment) => ({
							body: comment.body,
							user: { login: comment.author.login },
							created_at: comment.createdAt,
						}),
					);
				} else if (data.comments_url) {
					// Regular issue comments
					let page = 1;
					const perPage = 100;

					while (true) {
						const commentsUrl = `${data.comments_url}?per_page=${perPage}&page=${page}`;
						const commentsResponse = await fetch(commentsUrl, { headers });
						const comments = await commentsResponse.json();

						if (!Array.isArray(comments) || comments.length === 0) break;
						allComments = [...allComments, ...comments];

						if (comments.length < perPage) break;
						page++;
					}
				}

				// Fetch events for issues and PRs
				if (
					notification.subject.type === "Issue" ||
					notification.subject.type === "PullRequest"
				) {
					const eventsUrl = notification.subject.url.replace(/\/?$/, "/events");
					let page = 1;
					const perPage = 100;

					while (true) {
						const eventsUrl2 = `${eventsUrl}?per_page=${perPage}&page=${page}`;
						const eventsResponse = await fetch(eventsUrl2, { headers });
						const events = await eventsResponse.json();

						if (!Array.isArray(events) || events.length === 0) break;
						allEvents = [...allEvents, ...events];

						if (events.length < perPage) break;
						page++;
					}
				}

				setEvents(allEvents);
				setTotalComments(allComments.length);

				// Combine and sort comments and events
				if (allComments.length > 0 || allEvents.length > 0) {
					const timeline: TimelineItem[] = [
						...allComments.map((comment) => ({
							type: "comment" as const,
							data: comment,
							created_at: comment.created_at,
						})),
						...allEvents
							.filter(
								(event) =>
									!["subscribed", "unsubscribed", "mentioned"].includes(
										event.event,
									),
							)
							.map((event) => ({
								type: "event" as const,
								data: event,
								created_at: event.created_at,
							})),
					].sort(
						(a, b) =>
							new Date(b.created_at).getTime() -
							new Date(a.created_at).getTime(),
					);

					displayContent += "## Timeline\n\n";
					displayContent += "---\n\n";

					// Only show first page initially
					const firstPageItems = timeline.slice(0, 30);
					for (let i = 0; i < firstPageItems.length; i++) {
						const item = firstPageItems[i];
						const nextItem =
							i < firstPageItems.length - 1 ? firstPageItems[i + 1] : null;

						if (item.type === "comment") {
							const comment = item.data as GitHubComment;
							displayContent += `### @${comment.user.login} - ${timeAgo.format(new Date(comment.created_at))}\n\n`;
							displayContent += `${comment.body}\n\n`;
							displayContent += "---\n\n";
						} else {
							const event = item.data as GitHubEvent;
							displayContent += `> _${timeAgo.format(new Date(event.created_at))} - ${formatEvent(event)}_\n\n`;
							// Add separator if next item is a comment
							if (nextItem && nextItem.type === "comment") {
								displayContent += "---\n\n";
							}
						}
					}

					// If there are more items, set up pagination
					if (timeline.length > 30) {
						const remainingItems = timeline.slice(30);
						const dataUrl = `data:application/json,${encodeURIComponent(JSON.stringify(remainingItems))}`;
						setNextCommentsPage(dataUrl);
					} else {
						setNextCommentsPage(null);
					}

					// Calculate initial average lines
					const commentLines = calculateAverageLines(
						firstPageItems
							.filter(
								(
									item,
								): item is TimelineItem & {
									type: "comment";
									data: GitHubComment;
								} => item.type === "comment",
							)
							.map((item) => item.data),
					);
					setAverageCommentLines(commentLines);
				}

				setContent(displayContent);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to fetch content",
				);
			} finally {
				setLoading(false);
			}
		};

		fetchContent();
	}, [notification, calculateAverageLines]);

	const fetchMoreComments = useCallback(async () => {
		if (!nextCommentsPage || isFetchingMoreComments) return;

		setIsFetchingMoreComments(true);
		try {
			// If it's a data URL, parse the stored items
			if (nextCommentsPage.startsWith("data:")) {
				const jsonStr = decodeURIComponent(nextCommentsPage.split(",")[1]);
				const items: TimelineItem[] = JSON.parse(jsonStr);

				// Take next batch
				const nextBatch = items.slice(0, 30);
				let newContent = "";
				for (const item of nextBatch) {
					if (item.type === "comment") {
						const comment = item.data as GitHubComment;
						newContent += `### @${comment.user.login} - ${timeAgo.format(new Date(comment.created_at))}\n\n`;
						newContent += `${comment.body}\n\n`;
					} else {
						const event = item.data as GitHubEvent;
						newContent += `### Event - ${timeAgo.format(new Date(event.created_at))}\n\n`;
						newContent += `${formatEvent(event)}\n\n`;
					}
					newContent += "---\n\n";
				}

				setContent((prev) => prev + newContent);

				// If there are more items, update the data URL
				if (items.length > 30) {
					const remainingItems = items.slice(30);
					const dataUrl = `data:application/json,${encodeURIComponent(JSON.stringify(remainingItems))}`;
					setNextCommentsPage(dataUrl);
				} else {
					setNextCommentsPage(null);
				}

				// Update average lines calculation
				const commentLines = calculateAverageLines(
					nextBatch
						.filter(
							(
								item,
							): item is TimelineItem & {
								type: "comment";
								data: GitHubComment;
							} => item.type === "comment",
						)
						.map((item) => item.data),
				);
				setAverageCommentLines((prev) =>
					prev === 0 ? commentLines : Math.ceil((prev + commentLines) / 2),
				);
			}
		} catch (error) {
			console.error("Error fetching more items:", error);
		} finally {
			setIsFetchingMoreComments(false);
		}
	}, [nextCommentsPage, isFetchingMoreComments, calculateAverageLines]);

	// Effect to fetch more comments when scrolling near the bottom
	useEffect(() => {
		const contentLines = renderedContent.split("\n");
		const remainingLines = contentLines.length - (scrollOffset + maxLines);

		// If we're within 2 screens of the bottom and there are more comments to fetch
		if (
			remainingLines < maxLines * 2 &&
			nextCommentsPage &&
			!isFetchingMoreComments
		) {
			void fetchMoreComments();
		}
	}, [
		scrollOffset,
		renderedContent,
		maxLines,
		nextCommentsPage,
		isFetchingMoreComments,
		fetchMoreComments,
	]);

	const unsubscribe = async () => {
		setIsUnsubscribing(true);
		try {
			const token = config.get("githubToken");
			const headers = {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github.v3+json",
			};

			// The subscription URL is in the same format as the thread URL but with /subscription at the end
			const subscriptionUrl = `${notification.subscription_url}`;

			await fetch(subscriptionUrl, {
				method: "DELETE",
				headers,
			});

			// Mark as read and go back
			onBack(true);
		} catch (error) {
			console.error("Failed to unsubscribe:", error);
			setError("Failed to unsubscribe from notifications");
		} finally {
			setIsUnsubscribing(false);
		}
	};

	useInput((input, key) => {
		const contentLines = renderedContent.split("\n");
		const maxScroll = Math.max(0, contentLines.length - maxLines);

		if (key.return) {
			onBack(key.ctrl);
		} else if (key.escape || key.backspace || key.delete) {
			onBack(false);
		} else if ((key.upArrow || input === "k") && scrollOffset > 0) {
			setScrollOffset((prev) => Math.max(0, prev - 1));
		} else if ((key.downArrow || input === "j") && scrollOffset < maxScroll) {
			setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
		} else if (
			(key.pageUp || input === "b" || (key.ctrl && input === "u")) &&
			scrollOffset > 0
		) {
			setScrollOffset((prev) => Math.max(0, prev - maxLines));
		} else if (
			(key.pageDown || input === "f" || (key.ctrl && input === "d")) &&
			scrollOffset < maxScroll
		) {
			setScrollOffset((prev) => Math.min(maxScroll, prev + maxLines));
		} else if (input === "g") {
			setScrollOffset(0);
		} else if (input === "G") {
			setScrollOffset(maxScroll);
		} else if (input === "o") {
			open(getWebUrl(notification));
		} else if (input === "u" && !isUnsubscribing) {
			void unsubscribe();
		}
	});

	if (loading) {
		return (
			<Box>
				<Text color="green">
					<Spinner type="dots" />
				</Text>
				<Text> Loading notification content...</Text>
			</Box>
		);
	}

	if (error) {
		return (
			<Box flexDirection="column">
				<Text color="red">{error}</Text>
				<Text>Press Enter to go back</Text>
			</Box>
		);
	}

	const contentLines = renderedContent.split("\n");
	const totalLines = contentLines.length;
	const displayedContent = contentLines
		.slice(scrollOffset, scrollOffset + maxLines)
		.join("\n");

	// Calculate estimated total lines including unfetched comments
	const estimatedRemainingCommentLines =
		nextCommentsPage && averageCommentLines > 0
			? Math.max(0, totalComments - contentLines.length / averageCommentLines) *
				averageCommentLines
			: 0;
	const estimatedTotalLines =
		contentLines.length + estimatedRemainingCommentLines;

	const scrollPercentage =
		estimatedTotalLines <= maxLines
			? 100
			: Math.round(
					(scrollOffset / Math.max(1, estimatedTotalLines - maxLines)) * 100,
				);
	const canScrollDown =
		scrollOffset < contentLines.length - maxLines || nextCommentsPage !== null;
	const canScrollUp = scrollOffset > 0;

	return (
		<Box flexDirection="column">
			<Box marginBottom={1} flexDirection="column">
				<Text bold color="blue">
					{notification.subject.title}
					{isUnsubscribing && (
						<Text color="yellow">
							{" "}
							<Spinner type="dots" /> Unsubscribing...
						</Text>
					)}
					{isFetchingMoreComments && (
						<Text color="yellow">
							{" "}
							<Spinner type="dots" /> Loading more comments...
						</Text>
					)}
				</Text>
				<Text dimColor>
					Updated {timeAgo.format(new Date(notification.updated_at))}
				</Text>
			</Box>
			<Box marginBottom={1}>
				<Text>{displayedContent}</Text>
			</Box>
			<Box>
				<Text dimColor>
					{canScrollUp && "↑ "}Scroll with arrows/PgUp/PgDn/Ctrl+u/Ctrl+d
					{canScrollDown && " ↓"} •{scrollPercentage}% • Enter to go back •
					Ctrl+Enter to mark as read • o to open in browser • u to unsubscribe
					{nextCommentsPage && " • More comments available"}
				</Text>
			</Box>
		</Box>
	);
};

// Helper function to convert color names to ANSI codes
const getColorCode = (color: string): number => {
	switch (color) {
		case "red":
			return 31;
		case "green":
			return 32;
		case "yellow":
			return 33;
		case "blue":
			return 34;
		case "magenta":
			return 35;
		case "cyan":
			return 36;
		case "dim":
			return 2;
		default:
			return 0;
	}
};

const CustomSelect = ({
	items,
	onSelect,
	onMarkAsRead,
	onMarkGroupAsRead,
	onOpenInBrowser,
	onForceRefresh,
	isRefreshing,
	limit,
	initialSelectedIndex = 0,
	initialStartIndex = 0,
	onIndexChange,
}: {
	items: Item[];
	onSelect: (item: Item) => void;
	onMarkAsRead: (item: Item) => Promise<void>;
	onMarkGroupAsRead: (
		groupName: string,
		notifications: GitHubNotification[],
	) => Promise<void>;
	onOpenInBrowser: (item: Item) => void;
	onForceRefresh: () => void;
	isRefreshing: boolean;
	limit: number;
	initialSelectedIndex?: number;
	initialStartIndex?: number;
	onIndexChange?: (selectedIndex: number, startIndex: number) => void;
}) => {
	const [selectedIndex, setSelectedIndex] = useState(initialSelectedIndex);
	const [startIndex, setStartIndex] = useState(initialStartIndex);
	const [confirmingMark, setConfirmingMark] = useState(false);
	const statusWidth = 20;

	// Initialize position on mount and when initial indices change
	useEffect(() => {
		setSelectedIndex(initialSelectedIndex);
		setStartIndex(initialStartIndex);
	}, [initialSelectedIndex, initialStartIndex]);

	// Only adjust indices if they're out of bounds
	useEffect(() => {
		const maxIndex = items.length - 1;
		if (selectedIndex > maxIndex) {
			const newSelectedIndex = maxIndex;
			const newStartIndex = Math.max(
				0,
				Math.min(startIndex, maxIndex - limit + 1),
			);
			setSelectedIndex(newSelectedIndex);
			setStartIndex(newStartIndex);
			onIndexChange?.(newSelectedIndex, newStartIndex);
		}
	}, [items, limit, selectedIndex, startIndex, onIndexChange]);

	useInput((input, key) => {
		// Clear confirmation state on any key except right arrow
		if (!key.rightArrow) {
			setConfirmingMark(false);
		}

		if (key.upArrow || input === "k") {
			setSelectedIndex((prev) => {
				const newIndex = Math.max(0, prev - 1);
				if (newIndex < startIndex) {
					setStartIndex(newIndex);
					onIndexChange?.(newIndex, newIndex);
				} else {
					onIndexChange?.(newIndex, startIndex);
				}
				return newIndex;
			});
		} else if (key.downArrow || input === "j") {
			setSelectedIndex((prev) => {
				const newIndex = Math.min(items.length - 1, prev + 1);
				if (newIndex >= startIndex + limit) {
					const newStartIndex = newIndex - limit + 1;
					setStartIndex(newStartIndex);
					onIndexChange?.(newIndex, newStartIndex);
				} else {
					onIndexChange?.(newIndex, startIndex);
				}
				return newIndex;
			});
		} else if (key.return) {
			onSelect(items[selectedIndex]);
		} else if (key.rightArrow) {
			const selectedItem = items[selectedIndex];
			if (
				selectedItem.value.type === "notification" &&
				selectedItem.value.data &&
				!selectedItem.isLoading
			) {
				if (confirmingMark) {
					void onMarkAsRead(selectedItem);
					setConfirmingMark(false);
				} else {
					setConfirmingMark(true);
				}
			} else if (
				selectedItem.value.type === "group" &&
				selectedItem.value.name &&
				selectedItem.value.notifications &&
				!selectedItem.isLoading
			) {
				if (confirmingMark) {
					void onMarkGroupAsRead(
						selectedItem.value.name,
						selectedItem.value.notifications,
					);
					setConfirmingMark(false);
				} else {
					setConfirmingMark(true);
				}
			}
		} else if (input === "o") {
			const selectedItem = items[selectedIndex];
			if (
				selectedItem.value.type === "notification" &&
				selectedItem.value.data
			) {
				onOpenInBrowser(selectedItem);
			}
		} else if (input === "r" && !isRefreshing) {
			onForceRefresh();
		}
	});

	const visibleItems = items.slice(startIndex, startIndex + limit);
	const totalItems = items.length;

	return (
		<Box flexDirection="column">
			{visibleItems.map((item, index) => {
				const isSelected = index + startIndex === selectedIndex;
				const isConfirming = isSelected && confirmingMark;
				return (
					<Box key={item.key}>
						<Text color={isSelected ? "blue" : undefined}>
							{isSelected ? "❯ " : "  "}
							{item.label}
							{item.reasonText && !isConfirming && !item.isLoading && (
								<>
									{" "}
									<Text color={item.reasonColor}>{item.reasonText}</Text>
									<Text>{item.timeText}</Text>
								</>
							)}
							{isConfirming && !item.isLoading && (
								<>
									{" "}
									<Text color="yellow">
										{"→ press → to confirm".padEnd(statusWidth)}
									</Text>
									{item.timeText && <Text>{item.timeText}</Text>}
								</>
							)}
							{item.isLoading && (
								<>
									{" "}
									<Text color="yellow">
										<Spinner type="dots" /> Marking as read...
									</Text>
									{item.timeText && <Text>{item.timeText}</Text>}
								</>
							)}
						</Text>
					</Box>
				);
			})}
			<Box marginTop={1}>
				<Text dimColor>
					{totalItems > limit && (
						<>
							{startIndex > 0 && "↑ "}
							{Math.round(((selectedIndex + 1) / totalItems) * 100)}%
							{startIndex + limit < totalItems && " ↓"} •{" "}
						</>
					)}
					Enter to view • → to mark as read • o to open in browser • r to
					refresh • ↑/↓ or j/k to navigate • q to quit
				</Text>
			</Box>
		</Box>
	);
};

const NotificationList = ({
	groups,
	onSelect,
	onToggleGroup,
	onMarkAsRead,
	selectedIndex = 0,
	startIndex = 0,
	onIndexChange,
	currentUser,
	onForceRefresh,
	isRefreshing,
}: {
	groups: NotificationGroup[];
	onSelect: (notification: GitHubNotification) => void;
	onToggleGroup: (groupName: string) => void;
	onMarkAsRead: (notification: GitHubNotification) => Promise<void>;
	selectedIndex?: number;
	startIndex?: number;
	onIndexChange?: (selectedIndex: number, startIndex: number) => void;
	currentUser: { login: string } | null;
	onForceRefresh: () => void;
	isRefreshing: boolean;
}) => {
	const { stdout } = useStdout();
	const maxVisibleItems = stdout.rows - 3;
	const [loadingItems, setLoadingItems] = useState<Set<string>>(new Set());
	const [prStates, setPrStates] = useState<
		Record<string, { state: string; approved?: boolean }>
	>({});
	const [visibleStartIndex, setVisibleStartIndex] = useState(startIndex);
	const [loadingPRStates, setLoadingPRStates] = useState<Set<string>>(
		new Set(),
	);
	const queuedPRsRef = React.useRef<Set<string>>(new Set());

	// Create a persistent queue instance
	const queueRef = React.useRef<PQueue>();
	if (!queueRef.current) {
		queueRef.current = new PQueue({ concurrency: 4 });
	}

	// Keep track of which notifications are currently visible
	useEffect(() => {
		setVisibleStartIndex(startIndex);
	}, [startIndex]);

	// Queue up unfetched PR notifications for fetching
	useEffect(() => {
		if (!currentUser) return;

		const allNotifications = groups.flatMap((group) =>
			group.expanded ? group.notifications : [],
		);

		const visibleNotifications = allNotifications.slice(
			visibleStartIndex,
			visibleStartIndex + maxVisibleItems,
		);

		// Create a stable reference to prStates for the filter
		const currentPRStates = prStates;
		const unfetchedPRs = visibleNotifications.filter(
			(n) =>
				n.subject.type === "PullRequest" &&
				!currentPRStates[n.id] &&
				!queuedPRsRef.current.has(n.id),
		);

		// Skip if no unfetched PRs
		if (unfetchedPRs.length === 0) return;

		const fetchPRState = async (notification: GitHubNotification) => {
			setLoadingPRStates((prev) => new Set([...prev, notification.id]));

			try {
				const token = config.get("githubToken");
				const headers = {
					Authorization: `token ${token}`,
					Accept: "application/vnd.github.v3+json",
				};

				const response = await fetch(notification.subject.url, { headers });
				const pr = await response.json();

				// Get review status if PR is still open
				let approved = false;
				if (pr.state === "open") {
					const reviewsResponse = await fetch(
						`${notification.subject.url}/reviews`,
						{ headers },
					);
					const reviews = await reviewsResponse.json();

					if (Array.isArray(reviews)) {
						const userReviews = reviews.filter(
							(review) =>
								review.user.login === currentUser.login &&
								review.state === "APPROVED",
						);
						approved = userReviews.length > 0;
					}
				}

				setPrStates((prev) => ({
					...prev,
					[notification.id]: {
						state: pr.merged ? "merged" : pr.state,
						approved,
					},
				}));
			} catch (error) {
				console.error("Error fetching PR state:", error);
			} finally {
				setLoadingPRStates((prev) => {
					const next = new Set(prev);
					next.delete(notification.id);
					return next;
				});
				queuedPRsRef.current.delete(notification.id);
			}
		};

		// Add each unfetched PR to the queue
		for (const notification of unfetchedPRs) {
			queuedPRsRef.current.add(notification.id);
			queueRef.current?.add(() => fetchPRState(notification));
		}
	}, [groups, visibleStartIndex, maxVisibleItems, currentUser, prStates]);

	// Clean up the queue when component unmounts
	useEffect(() => {
		return () => {
			queueRef.current?.clear();
			queuedPRsRef.current.clear();
		};
	}, []);

	// Helper function to format the reason with color
	const formatReason = (reason: string): [string, string] => {
		switch (reason) {
			case "assign":
				return ["assigned", "yellow"];
			case "author":
				return ["you created", "green"];
			case "comment":
				return ["new comment", "cyan"];
			case "invitation":
				return ["invited", "magenta"];
			case "manual":
				return ["subscribed", "blue"];
			case "mention":
				return ["mentioned", "yellow"];
			case "review_requested":
				return ["review requested", "magenta"];
			case "security_alert":
				return ["security alert", "red"];
			case "state_change":
				return ["state changed", "cyan"];
			case "subscribed":
				return ["watching", "blue"];
			case "team_mention":
				return ["team mentioned", "yellow"];
			default:
				return [reason.replace("_", " "), "white"];
		}
	};

	// Calculate column widths
	const statusWidth = 20; // Fixed width for status
	const timeWidth = 15; // Fixed width for time
	const prStateWidth = 12; // Fixed width for PR state (e.g., "[merged ✓]")
	const padding = 4; // Space for margins and separators
	const titleWidth =
		stdout.columns - statusWidth - timeWidth - prStateWidth - padding - padding;

	const items = groups.flatMap((group) => {
		const mostRecent = group.notifications.reduce((latest, notification) => {
			return new Date(notification.updated_at) > new Date(latest.updated_at)
				? notification
				: latest;
		}, group.notifications[0]);

		const groupItem: Item = {
			key: group.name,
			label: `${group.expanded ? "📂" : "📁"} ${group.name} (${group.notifications.length}) • ${timeAgo.format(new Date(mostRecent.updated_at))}`,
			value: {
				type: "group" as const,
				name: group.name,
				notifications: group.notifications,
			},
			isLoading: loadingItems.has(group.name),
		};

		return [
			groupItem,
			...(group.expanded
				? group.notifications.map((notification): Item => {
						const [reasonText, reasonColor] = formatReason(notification.reason);
						const title =
							notification.subject.title.length > titleWidth
								? `${notification.subject.title.slice(0, titleWidth - 3)}...`
								: notification.subject.title.padEnd(titleWidth);

						const isPR = notification.subject.type === "PullRequest";
						const prState = isPR ? prStates[notification.id] : undefined;
						const isLoading = isPR && loadingPRStates.has(notification.id);
						let stateText = "";

						if (isPR) {
							if (isLoading) {
								stateText = " [loading]";
							} else if (prState) {
								stateText = ` [${prState.state}${prState.approved ? " ✓" : ""}]`;
							} else {
								stateText = " [      ]"; // Placeholder to maintain width
							}
							stateText = stateText.padEnd(prStateWidth);
						}

						return {
							key: notification.id,
							label: `  ${title}${stateText}`,
							value: { type: "notification" as const, data: notification },
							reasonText: reasonText.padEnd(statusWidth),
							reasonColor,
							timeText: timeAgo
								.format(new Date(notification.updated_at))
								.padStart(timeWidth),
							isLoading: loadingItems.has(notification.id),
							prState,
							isPRStateLoading: isLoading,
						};
					})
				: []),
		];
	});

	const totalNotifications = groups.reduce(
		(sum, group) => sum + group.notifications.length,
		0,
	);

	items.push({
		key: "exit",
		label: `Exit (${totalNotifications} total notifications)`,
		value: { type: "exit" as const },
	});

	return (
		<CustomSelect
			items={items}
			onSelect={(item: Item) => {
				if (item.value.type === "notification" && item.value.data) {
					onSelect(item.value.data);
				} else if (item.value.type === "group" && item.value.name) {
					onToggleGroup(item.value.name);
				} else if (item.value.type === "exit") {
					process.exit(0);
				}
			}}
			onMarkAsRead={async (item: Item) => {
				if (item.value.type === "notification" && item.value.data) {
					const notificationId = item.value.data.id;
					setLoadingItems((prev) => new Set([...prev, notificationId]));
					await onMarkAsRead(item.value.data);
					setLoadingItems((prev) => {
						const next = new Set(prev);
						next.delete(notificationId);
						return next;
					});
				}
			}}
			onMarkGroupAsRead={async (
				groupName: string,
				notifications: GitHubNotification[],
			) => {
				setLoadingItems((prev) => new Set([...prev, groupName]));
				for (const notification of notifications) {
					await onMarkAsRead(notification);
				}
				setLoadingItems((prev) => {
					const next = new Set(prev);
					next.delete(groupName);
					return next;
				});
			}}
			onOpenInBrowser={(item: Item) => {
				if (item.value.type === "notification" && item.value.data) {
					open(getWebUrl(item.value.data));
				}
			}}
			onForceRefresh={onForceRefresh}
			isRefreshing={isRefreshing}
			limit={maxVisibleItems}
			initialSelectedIndex={selectedIndex}
			initialStartIndex={startIndex}
			onIndexChange={onIndexChange}
		/>
	);
};

const App = () => {
	const [token, setToken] = useState<string | null>(
		config.get("githubToken") as string | null,
	);
	const [loading, setLoading] = useState(false);
	const [groups, setGroups] = useState<NotificationGroup[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [selectedNotification, setSelectedNotification] =
		useState<GitHubNotification | null>(null);
	const [loadingProgress, setLoadingProgress] = useState<string | null>(null);
	const [listPosition, setListPosition] = useState({
		selectedIndex: 0,
		startIndex: 0,
	});
	const [currentUser, setCurrentUser] = useState<{ login: string } | null>(
		null,
	);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Helper function to group notifications
	const groupNotifications = useCallback(
		(notifications: GitHubNotification[]) => {
			const groupedNotifications = notifications.reduce(
				(acc, notification) => {
					const repoFullName = notification.repository.full_name;
					if (!acc[repoFullName]) {
						acc[repoFullName] = [];
					}
					acc[repoFullName].push(notification);
					return acc;
				},
				{} as Record<string, GitHubNotification[]>,
			);

			return Object.entries(groupedNotifications).map(
				([repoName, notifications]) => ({
					name: repoName,
					notifications,
					expanded: false,
				}),
			);
		},
		[],
	);

	// Function to fetch notifications
	const fetchNotifications = useCallback(
		async (forceRefresh = false) => {
			if (!token) return;

			setLoading(true);
			setError(null);
			setIsRefreshing(true);

			try {
				const octokit = new Octokit({ auth: token });
				let page = 1;
				let allNotifications: GitHubNotification[] = [];
				const lastFetchTime = forceRefresh
					? new Date(0).toISOString()
					: (config.get("lastFetchTime") as string);
				const cachedNotifications = forceRefresh
					? []
					: (config.get("notifications") as GitHubNotification[]);

				// Start with cached notifications if not force refreshing
				if (!forceRefresh && cachedNotifications.length > 0) {
					allNotifications = cachedNotifications;
					setGroups(groupNotifications(cachedNotifications));
				}

				// Fetch new notifications
				while (true) {
					setLoadingProgress(
						`Fetching ${forceRefresh ? "all" : "new"} notifications (page ${page})...`,
					);
					const { data: notifications, headers } =
						await octokit.activity.listNotificationsForAuthenticatedUser({
							all: false,
							participating: false,
							per_page: 100,
							page,
							since: lastFetchTime,
						});

					if (notifications.length === 0) break;

					// Add new notifications to our list
					const newNotifications = notifications.filter(
						(notification) =>
							!allNotifications.some((n) => n.id === notification.id),
					);
					allNotifications = [...newNotifications, ...allNotifications];

					// Check if there are more pages
					const links = headers.link;
					if (!links || !links.includes('rel="next"')) break;

					page++;
				}

				// Update cache
				config.set("notifications", allNotifications);
				config.set("lastFetchTime", new Date().toISOString());

				if (allNotifications.length === 0) {
					setError("No unread notifications!");
					return;
				}

				// Sort notifications by updated_at in descending order
				allNotifications.sort(
					(a, b) =>
						new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
				);

				setGroups(groupNotifications(allNotifications));
			} catch (err) {
				// If the token is invalid (401) or lacks permissions (403), clear it
				// so the user gets the token prompt again
				const status = (err as { status?: number }).status;
				if (status === 401 || status === 403) {
					config.set("githubToken", "");
					setToken(null);
				} else {
					setError(
						err instanceof Error ? err.message : "Unknown error occurred",
					);
				}
			} finally {
				setLoadingProgress(null);
				setLoading(false);
				setIsRefreshing(false);
			}
		},
		[token, groupNotifications],
	);

	// Initial fetch effect
	useEffect(() => {
		void fetchNotifications(false);
	}, [fetchNotifications]);

	const handleForceRefresh = useCallback(() => {
		if (!isRefreshing && !loading) {
			void fetchNotifications(true);
		}
	}, [isRefreshing, loading, fetchNotifications]);

	useInput((input, key) => {
		if (input === "q" || (key.ctrl && input === "c")) {
			process.exit(0);
		}
	});

	// Fetch user info when token is set
	useEffect(() => {
		const fetchUserInfo = async () => {
			if (!token) return;

			try {
				const octokit = new Octokit({ auth: token });
				const { data: user } = await octokit.users.getAuthenticated();
				setCurrentUser(user);
			} catch (err) {
				const status = (err as { status?: number }).status;
				if (status === 401 || status === 403) {
					config.set("githubToken", "");
					setToken(null);
				}
			}
		};

		void fetchUserInfo();
	}, [token]);

	if (!token) {
		return <TokenPrompt onToken={setToken} />;
	}

	if (loading) {
		return (
			<Box flexDirection="column">
				<Box>
					<Text color="green">
						<Spinner type="dots" />
					</Text>
					<Text> Loading notifications...</Text>
				</Box>
				{loadingProgress && (
					<Box marginTop={1}>
						<Text dimColor>{loadingProgress}</Text>
					</Box>
				)}
			</Box>
		);
	}

	if (error) {
		return <Text color="red">{error}</Text>;
	}

	return (
		<Box flexDirection="column">
			<Box marginBottom={1}>
				<Text>🔔 GitHub Notifications (Press 'q' to exit)</Text>
				{isRefreshing && (
					<Text color="yellow">
						{" "}
						<Spinner type="dots" /> Refreshing...
					</Text>
				)}
			</Box>
			{groups.length === 0 ? (
				<Text>No unread notifications!</Text>
			) : selectedNotification ? (
				<NotificationContent
					notification={selectedNotification}
					onBack={async (markAsRead?: boolean) => {
						if (markAsRead) {
							// Optimistically update UI first
							const updatedNotifications = (
								config.get("notifications") as GitHubNotification[]
							).filter((n) => n.id !== selectedNotification.id);
							config.set("notifications", updatedNotifications);

							setGroups((prevGroups) => {
								const newGroups = prevGroups.map((group) => ({
									...group,
									notifications: group.notifications.filter(
										(n) => n.id !== selectedNotification.id,
									),
								}));
								return newGroups.filter(
									(group) => group.notifications.length > 0,
								);
							});

							try {
								const octokit = new Octokit({ auth: token });
								await octokit.activity.markThreadAsRead({
									thread_id: Number.parseInt(selectedNotification.id),
								});
							} catch (err) {
								// If the API call fails, revert the optimistic update
								config.set("notifications", [
									...updatedNotifications,
									selectedNotification,
								]);
								setGroups((prevGroups) => {
									const targetGroup = prevGroups.find(
										(group) =>
											group.name === selectedNotification.repository.full_name,
									);
									if (targetGroup) {
										return prevGroups.map((group) =>
											group.name === selectedNotification.repository.full_name
												? {
														...group,
														notifications: [
															...group.notifications,
															selectedNotification,
														],
													}
												: group,
										);
									}
									return [
										...prevGroups,
										{
											name: selectedNotification.repository.full_name,
											notifications: [selectedNotification],
											expanded: true,
										},
									];
								});
								setError(
									err instanceof Error ? err.message : "Failed to mark as read",
								);
							}
						}
						setSelectedNotification(null);
					}}
				/>
			) : (
				<NotificationList
					groups={groups}
					onSelect={(notification) => {
						setSelectedNotification(notification);
					}}
					onToggleGroup={(groupName) => {
						setGroups((prevGroups) =>
							prevGroups.map((group) =>
								group.name === groupName
									? { ...group, expanded: !group.expanded }
									: group,
							),
						);
					}}
					onMarkAsRead={async (notification) => {
						// Optimistically update UI first
						const updatedNotifications = (
							config.get("notifications") as GitHubNotification[]
						).filter((n) => n.id !== notification.id);
						config.set("notifications", updatedNotifications);

						setGroups((prevGroups) => {
							const newGroups = prevGroups.map((group) => ({
								...group,
								notifications: group.notifications.filter(
									(n) => n.id !== notification.id,
								),
							}));
							return newGroups.filter(
								(group) => group.notifications.length > 0,
							);
						});

						try {
							const octokit = new Octokit({ auth: token });
							await octokit.activity.markThreadAsRead({
								thread_id: Number.parseInt(notification.id),
							});
						} catch (err) {
							// If the API call fails, revert the optimistic update
							config.set("notifications", [
								...updatedNotifications,
								notification,
							]);
							setGroups((prevGroups) => {
								const targetGroup = prevGroups.find(
									(group) => group.name === notification.repository.full_name,
								);
								if (targetGroup) {
									return prevGroups.map((group) =>
										group.name === notification.repository.full_name
											? {
													...group,
													notifications: [...group.notifications, notification],
												}
											: group,
									);
								}
								return [
									...prevGroups,
									{
										name: notification.repository.full_name,
										notifications: [notification],
										expanded: true,
									},
								];
							});
							setError(
								err instanceof Error ? err.message : "Failed to mark as read",
							);
						}
					}}
					selectedIndex={listPosition.selectedIndex}
					startIndex={listPosition.startIndex}
					onIndexChange={(selectedIndex, startIndex) => {
						setListPosition({ selectedIndex, startIndex });
					}}
					currentUser={currentUser}
					onForceRefresh={handleForceRefresh}
					isRefreshing={isRefreshing}
				/>
			)}
		</Box>
	);
};

render(<App />);
