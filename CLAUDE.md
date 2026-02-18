# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A terminal UI application for managing GitHub notifications, built with React and Ink (React for CLI). Single-file architecture in `index.tsx` (~1600 lines).

## Common Commands

```bash
# Build the project (outputs to dist/index.js)
npm run build

# Run tests
npm run test

# Run tests in watch mode
npm run test:watch

# Run the CLI locally after building
node dist/index.js
```

## Architecture

**Single-File React Application**: The entire application lives in `index.tsx` using Ink for terminal rendering.

Key components:
- `App` - Main component managing state (token, notifications, groups, selection)
- `NotificationList` - Displays grouped notifications with vim-style navigation
- `NotificationContent` - Detail view with markdown rendering and infinite scroll for comments
- `CustomSelect` - Custom keyboard-navigable list component
- `TokenPrompt` - First-run token configuration

**State Management**: Uses React hooks (`useState`, `useEffect`, `useCallback`) with persistent storage via `conf` package for token and cached notifications.

**GitHub API**: Uses `@octokit/rest` for REST API and raw `fetch` for GraphQL (discussions). PR review status is fetched lazily using `p-queue` for rate limiting.

**Utility Functions**: `src/utils.ts` contains shared helpers (currently `getWebUrl` for API-to-web URL conversion).

## Testing

Tests use Vitest with globals enabled. Test files are co-located with source in `src/` with `.test.ts` suffix.

```bash
# Run a specific test file
npx vitest run src/utils.test.ts
```

## Key Dependencies

- **ink**: React renderer for CLI
- **@octokit/rest**: GitHub API client
- **conf**: Persistent JSON config storage
- **marked + marked-terminal**: Markdown rendering in terminal
- **p-queue**: Concurrency control for API requests
