---
name: write-docs
description: Generate project documentation. API docs, README, installation guide, deployment guide, changelog. Clear, discoverable, user-friendly.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---


# Write Documentation

You are a technical writer. Your job is to explain your software clearly so users and developers can succeed.

## When to use

- Shipping new feature (needs user guide)
- New open-source project (needs README + guides)
- API change (needs API docs update)
- Releasing version (needs changelog)
- Setting up complex system (needs deployment guide)

## README (Landing Page)

Your README is the first thing people read. It should answer:
1. "What is this?" (1 sentence)
2. "Why should I care?" (2-3 sentences)
3. "How do I get started?" (5 min quick start)
4. "Where do I learn more?" (Links to docs)

### Structure

```markdown
# Project Name

> One-sentence description. What does it do?

## Features

- Feature 1: Benefit to user
- Feature 2: Benefit to user
- Feature 3: Benefit to user

## Quick Start

### Install
\`\`\`bash
npm install package-name
# or
pip install package-name
\`\`\`

### Usage
\`\`\`javascript
import { thing } from 'package-name';

thing.doSomething();  // Output: Result
\`\`\`

## Documentation

- [Installation Guide](./docs/install.md) — Detailed setup
- [API Reference](./docs/api.md) — All functions/classes
- [Examples](./docs/examples/) — Real-world usage
- [Troubleshooting](./docs/troubleshooting.md) — Common issues

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT (or your license)
```

## Installation Guide

For anything beyond "npm install":

```markdown
# Installation Guide

## Supported Platforms
- Linux (Ubuntu 20.04+)
- macOS 11+
- Windows 10+ (with WSL2)

## Prerequisites
- Node 18+
- PostgreSQL 12+
- Redis 6+

## Steps

### 1. Clone Repository
\`\`\`bash
git clone https://github.com/user/project.git
cd project
\`\`\`

### 2. Install Dependencies
\`\`\`bash
npm install
\`\`\`

### 3. Configure Environment
\`\`\`bash
cp .env.example .env
# Edit .env with your settings:
# - DATABASE_URL=postgresql://...
# - REDIS_URL=redis://...
\`\`\`

### 4. Setup Database
\`\`\`bash
npm run db:migrate
npm run db:seed  # Optional: load example data
\`\`\`

### 5. Start Development Server
\`\`\`bash
npm run dev
# Visit http://localhost:3000
\`\`\`

## Troubleshooting

### "Connection refused" error
- Check PostgreSQL is running: `pg_isready`
- Verify DATABASE_URL in .env is correct

### Port 3000 already in use
\`\`\`bash
npm run dev -- --port 3001
\`\`\`

See [Troubleshooting](./troubleshooting.md) for more.
```

## API Documentation

Organize by resource:

```markdown
# API Reference

## Authentication

All requests require Bearer token in Authorization header.

\`\`\`bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.example.com/users/me
\`\`\`

## Users

### Get Current User
\`\`\`http
GET /users/me
Authorization: Bearer YOUR_TOKEN

Response (200):
{
  "id": "usr_123",
  "email": "user@example.com",
  "name": "John Doe"
}
\`\`\`

### List Users (Admin Only)
\`\`\`http
GET /users
Authorization: Bearer YOUR_TOKEN (admin)

Query Parameters:
- page: [1-∞] (default: 1)
- limit: [1-100] (default: 20)
- sort: [name|created] (default: name)

Response (200):
{
  "data": [...],
  "page": 1,
  "limit": 20,
  "total": 150
}
\`\`\`

### Create User (Admin Only)
\`\`\`http
POST /users
Authorization: Bearer YOUR_TOKEN (admin)
Content-Type: application/json

Request Body:
{
  "email": "newuser@example.com",
  "name": "Jane",
  "role": "user"
}

Response (201):
{
  "id": "usr_456",
  "email": "newuser@example.com",
  "name": "Jane",
  "role": "user"
}

Errors:
- 400: Email already exists
- 403: Not an admin
\`\`\`

## Error Responses

All errors follow this format:

\`\`\`json
{
  "error": "error_code",
  "message": "Human-readable message"
}
\`\`\`

Common errors:
- `auth_required`: Missing/invalid token (401)
- `permission_denied`: Insufficient permissions (403)
- `not_found`: Resource doesn't exist (404)
- `validation_error`: Invalid input (400)
```

## Deployment Guide

For deploying to production:

```markdown
# Deployment Guide

## Pre-Deployment

### Checklist
- [ ] All tests passing (npm test)
- [ ] No console errors
- [ ] Build succeeds (npm run build)
- [ ] Staging deployed and verified
- [ ] Database migrations prepared
- [ ] Environment variables set

### Environment Variables

\`\`\`bash
# Create .env.production
NODE_ENV=production
DATABASE_URL=postgresql://...  # Production DB
REDIS_URL=redis://...          # Production Redis
SECRET_KEY=<32-char-random>
LOG_LEVEL=info
\`\`\`

## Deploy to Production

### Option 1: Docker

\`\`\`bash
# Build image
docker build -t myapp:latest .

# Push to registry
docker push myregistry.io/myapp:latest

# Update deployment
kubectl set image deployment/myapp \
  myapp=myregistry.io/myapp:latest
\`\`\`

### Option 2: Direct Server

\`\`\`bash
ssh deploy@production.example.com

# Pull latest code
cd /app && git pull origin main

# Install dependencies
npm ci --production

# Run migrations
npm run db:migrate

# Restart service
systemctl restart myapp
\`\`\`

## Verify Deployment

\`\`\`bash
# Health check
curl https://api.example.com/health

# Check logs
tail -f /var/log/myapp.log

# Monitor error rate
curl https://monitoring.example.com/metrics
\`\`\`

## Rollback

If something goes wrong:

\`\`\`bash
# Within 5 minutes:
git revert <commit-hash> && git push origin main

# Or restore previous Docker image:
docker pull myregistry.io/myapp:previous
kubectl set image deployment/myapp myapp=myregistry.io/myapp:previous
\`\`\`
```

## Changelog

Format changes for humans:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2024-01-15

### Added
- New `/export` endpoint for downloading data as CSV
- Dark mode theme support (Settings > Appearance)
- API authentication via Bearer tokens (more secure than API keys)

### Changed
- Updated database schema (run `npm run db:migrate`)
- Improved error messages (now shows what field failed validation)
- Default page size increased from 10 to 20 items

### Fixed
- Login failing for users with special characters in passwords (Security fix)
- Race condition in concurrent file uploads
- Mobile layout broken on screens < 320px

### Removed
- Legacy `/api/v1/` endpoints (use `/api/v2/` instead)

### Security
- Updated dependencies to patch XSS vulnerability
- Rate limiting added to login endpoint (5 attempts per 15 min)

## [1.1.0] - 2024-01-01

### Added
- Dark mode (experimental)
- API documentation (https://docs.example.com)

### Fixed
- Performance regression in search
```

## FAQ/Troubleshooting

Common questions and answers:

```markdown
# FAQ & Troubleshooting

## General

### Q: Is this suitable for production?
A: Yes. We use it at scale for [example]. See [Production Checklist](./docs/production.md).

### Q: What are the system requirements?
A: Linux/macOS, Node 18+, PostgreSQL 12+. See [Installation](./docs/install.md).

## Technical

### Q: How do I connect to a different database?
A: Edit `.env` and set `DATABASE_URL=postgresql://user:pass@host:5432/db`

### Q: How do I enable debugging?
A: Set `DEBUG=*` or `DEBUG=myapp:*` before running
\`\`\`bash
DEBUG=myapp:* npm run dev
\`\`\`

### Q: How do I contribute?
A: See [CONTRIBUTING.md](./CONTRIBUTING.md)

## Errors

### "Port 5432 already in use"
You have another PostgreSQL instance running.
\`\`\`bash
# Find and stop it
lsof -i :5432
kill -9 <PID>
\`\`\`

### "ECONNREFUSED 127.0.0.1:6379"
Redis is not running.
\`\`\`bash
redis-server  # Start Redis
# Or if using Docker: docker run -p 6379:6379 redis:7
\`\`\`
```

## Documentation Checklist

Before shipping:

```
README
- [ ] What is this? (1 sentence)
- [ ] Why care? (2-3 sentences)
- [ ] Quick start (5 min)
- [ ] Links to full docs

Installation
- [ ] Step-by-step guide
- [ ] All prerequisites listed
- [ ] Troubleshooting section

API Docs (if applicable)
- [ ] Every endpoint documented
- [ ] Example requests + responses
- [ ] Error codes explained
- [ ] Authentication explained

Deployment
- [ ] Pre-flight checklist
- [ ] Step-by-step deploy
- [ ] Verification steps
- [ ] Rollback procedure

Changelog
- [ ] What's new in this version
- [ ] What changed
- [ ] What's fixed
- [ ] Breaking changes called out
```

## Key Rules

1. **Write for humans** — Be clear, not clever
2. **Show examples** — Code samples > theoretical explanations
3. **Update when you ship** — Stale docs are worse than no docs
4. **Link liberally** — Help people navigate between pages
5. **Assume nothing** — What's obvious to you is not obvious to new users

## Principle

Great documentation is invisible — users get what they need and never think about it.
