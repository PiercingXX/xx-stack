# Contributing to xx-stack

Thank you for your interest in contributing to xx-stack! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/xx-stack.git`
3. Create a branch for your changes: `git checkout -b feature/your-feature-name`

## Development Setup

### Prerequisites

- Node.js 20+
- Git

### Installation

```bash
# Install dependencies
npm install

# Verify repository layout
node scripts/verify-repo-layout.mjs

# Sync VS Code agent mirrors
node scripts/sync-vscode-agents.mjs
```

### Git Hooks

The repository uses git hooks to ensure agent mirrors stay in sync:

```bash
git config core.hooksPath .githooks
```

This pre-commit hook runs `node scripts/sync-vscode-agents.mjs --check` to verify mirrors are up to date.

## Contribution Guidelines

### Code Style

- Follow existing code patterns and conventions
- Use meaningful variable and function names
- Add comments for complex logic
- Keep functions focused on a single responsibility

### Agent Development

When adding or modifying agents:

1. Update `runtime/agents/<name>.md` with the canonical agent definition
2. Update `runtime/config.json` to register the agent
3. Run `node scripts/sync-vscode-agents.mjs` to update VS Code mirrors
4. Test with your MCP-compatible host

### Skill Development

When adding or modifying skills:

1. Create `runtime/skills/<name>/SKILL.md` with the skill definition
2. Register it in `runtime/SKILLS.md`
3. Add adapter surfaces only when required by a downstream host

### Testing

- Run existing tests: `npm --prefix mcp-server test`
- Add tests for new functionality
- Verify layout: `node scripts/verify-repo-layout.mjs`

### Documentation

- Update README.md for user-facing changes
- Update this CONTRIBUTING.md for development process changes
- Add inline comments for complex logic

## Pull Request Process

1. Update documentation as needed
2. Run all verification scripts before submitting
3. Ensure all CI checks pass
4. Wait for review from maintainers
5. Address review comments and push updates

## Code of Conduct

- Be respectful and inclusive
- Accept constructive criticism gracefully
- Focus on what is best for the community
- Show empathy towards other community members

## Questions?

Feel free to open an issue for questions about contributing.

## Acknowledgments

- Thanks to all contributors who help improve xx-stack
- Your contributions make this project better for everyone
