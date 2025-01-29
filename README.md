# GitHub Notifier CLI

A beautiful terminal UI for managing GitHub notifications. View, read, and manage your GitHub notifications directly from the terminal.

## Features

- 🎯 View all your unread GitHub notifications
- 📝 Read issue/PR content and comments
- ✨ Beautiful terminal UI with syntax highlighting
- 🔄 Real-time updates
- 📂 Repository-based grouping
- ⌨️ Vim-style keyboard navigation
- 🌐 Open in browser support
- 📊 Pull request status indicators

## Installation

```bash
# Using npm
npm install -g github-notifier-cli

# Using pnpm
pnpm add -g github-notifier-cli

# Using yarn
yarn global add github-notifier-cli
```

## Usage

1. Run the command:
```bash
github-notifier
```

2. On first run, you'll be prompted to enter your GitHub personal access token. You can create one at https://github.com/settings/tokens with the following permissions:
   - `notifications` - to read and manage notifications
   - `repo` - to access private repositories

## Keyboard Shortcuts

- `↑/↓` or `j/k` - Navigate through notifications
- `Enter` - View selected notification
- `→` - Mark as read (press twice to confirm)
- `o` - Open in browser
- `q` - Quit
- `PgUp/PgDn` or `Ctrl+u/Ctrl+d` - Page up/down
- `g/G` - Go to top/bottom

## License

MIT
