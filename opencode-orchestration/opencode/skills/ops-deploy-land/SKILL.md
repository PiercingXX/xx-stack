---
name: ops-deploy-land
description: Post-deploy operations. Health verification, rollback procedure, canary monitoring, failure response. Ensure smooth production deployment.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---


# Post-Deploy Operations

You are an operations engineer. Your job is to ensure the deployment succeeds and catch problems in the first 30 minutes.

## When to use

- Just merged a PR to main/production
- Need to canary roll out (gradual 5% → 50% → 100%)
- Monitoring + alerting setup
- Rollback procedure
- Error rate / latency spikes detected

## Step 1: Pre-Deploy Checklist (Before Merge)

```bash
# ✓ All tests passing
npm test
npm run test:e2e

# ✓ Build succeeds
npm run build

# ✓ No console errors/warnings in browser
npm run dev  # Manual check

# ✓ Staging deployment works
npm run deploy:staging
# Visit staging URL, manual test

# ✓ Database migrations ready (if applicable)
npm run db:migrate:validate

# ✓ Feature flags configured (if new feature)
# Toggle feature flag in production (if doesn't break anything)

# ✓ Rollback procedure documented
# "If X goes wrong, run: Y"
```

## Step 2: Merge to Main

```bash
# Verify everything one more time
git log origin/main..HEAD --oneline  # What am I merging?
git diff origin/main...HEAD          # Show changes

# Merge with clean history
git rebase origin/main
git push origin main

# Wait for CI (GitHub Actions, etc.)
# See all checks green ✓
```

## Step 3: Canary Deployment (If Your Setup Supports)

Deploy to 5% of users first:

```bash
# Option 1: Feature flag (safest)
toggleFeatureFlag("new-feature", percentage: 5)
npm run deploy

# Option 2: Load balancer (if you have one)
# Route 5% traffic to new backend, 95% to old
# Monitor error rates for 5 minutes

# Option 3: Region-based (if multi-region)
# Deploy to lowest-traffic region first
# Monitor for 30 minutes before global rollout
```

## Step 4: Health Verification (First 30 Minutes Post-Deploy)

Watch these metrics every 2 minutes for 30 minutes:

### Errors
```bash
# Error rate should stay < 0.1% (or your baseline)
curl https://monitoring.internal/metrics/error-rate
# If spikes above baseline → ROLLBACK

# Critical errors
curl https://monitoring.internal/metrics/critical-errors
# Any spikes → Investigate immediately
```

### Performance
```bash
# Latency should stay within baseline
# p95 latency (95th percentile): 
#   Before: 200ms
#   After: Should be ≈ 200ms
# If > 250ms → Investigate (could be legitimate)
# If > 500ms → ROLLBACK
```

### User Sessions
```bash
# Are users logging in successfully?
curl https://monitoring.internal/metrics/login-success-rate
# If < 99% → Problem with auth changes
```

### Database Performance
```bash
# Query times should stay normal
# If your app is waiting on DB → rollback

# Active connections should be stable
# If climbing → Connection leak
```

### External Services
```bash
# Are 3rd-party APIs responding?
# Payment API, email service, etc.
# If they're down, your app is broken even if code is good
```

## Step 5: Gradual Rollout

If canary is healthy:

```bash
# After 10 minutes:
toggleFeatureFlag("new-feature", percentage: 25)

# After another 10 minutes:
toggleFeatureFlag("new-feature", percentage: 100)

# If any issues during canary → ROLLBACK (see Step 6)
```

## Step 6: Rollback Procedure

If health checks fail:

```bash
# ⚠️  DO THIS FAST. Every second of bad code affects users.

# Option 1: Feature flag reversal (30 seconds)
toggleFeatureFlag("new-feature", percentage: 0)
# Done. Users see old code immediately.

# Option 2: Git rollback (2 minutes)
git revert <commit-hash> && git push origin main
# CI redeploys automatically

# Option 3: Database rollback (depends on migration)
npm run db:rollback
# Then Option 2

# AFTER rollback:
# 1. Watch health metrics for 5 minutes (should return to normal quickly)
# 2. Post-mortem: What failed? Why didn't tests catch it?
# 3. Fix the issue, add test to prevent recurrence
# 4. Redeploy (now with test coverage)
```

## Step 7: Post-Deployment Monitoring

For 24 hours after deploy, watch for:

### Slow creeping issues
```
- Memory leaks (memory grows slowly over hours)
- Connection leaks (connections climb then crash at 100)
- Queue backlog building (jobs not processing fast enough)
- Cache miss rates increasing
```

### User-reported issues
- Have a Slack channel for support
- Monitor error reports from bug trackers
- If pattern emerges → Correlate with deployment time

### Background job failures
```bash
# If background jobs failing → Could indicate data format mismatch
# Check error queue
npm run jobs:status
```

## Health Check Commands

```bash
# Create these health check endpoints in your app

# Basic health (is server responding?)
GET /health
Response: { status: "ok", uptime: 3600 }

# Detailed health (can reach database, external APIs?)
GET /health/detailed
Response: {
  database: { status: "ok", latency: 45 },
  redis: { status: "ok", latency: 2 },
  external_api: { status: "ok", latency: 120 },
  uptime: 3600
}

# Error rate endpoint
GET /metrics/errors
Response: { rate: 0.005 }  # 0.5%

# Latency percentiles
GET /metrics/latency
Response: {
  p50: 50,
  p95: 200,
  p99: 500,
  p99_9: 1200
}
```

## Incident Response

If something is clearly broken:

```bash
### IMMEDIATE (Next 5 minutes)
1. Declare incident: "Deployment rollback in progress"
2. Rollback (see Step 6)
3. Verify metrics return to normal
4. Notify stakeholders: "Issue resolved"

### SHORT TERM (Next hour)
1. Analyze logs: What failed?
2. Identify root cause
3. Write fix + test

### FOLLOW UP (Next day)
1. Deploy fix
2. Post-mortem document: What happened? How do we prevent it?
3. Add test to prevent recurrence
```

## Output

```markdown
# Deployment Report

## Pre-Deployment
- [✓] All tests passing
- [✓] Staging verified
- [✓] Rollback procedure documented

## Deployment
- Started: [time]
- Completed: [time]
- Canary: [% traffic]

## Health Verification (30 min)
- Error rate: [baseline] → [post-deploy] ✓
- P95 latency: [baseline] → [post-deploy] ✓
- Login success: 99.9% ✓
- Database: Normal ✓

## Rollout (if canary)
- 5% at [time] ✓
- 25% at [time] ✓
- 100% at [time] ✓

## Status
✅ DEPLOYED SUCCESSFULLY

## Monitoring
- Continue health checks for 24 hours
- Alert on: Error rate > 0.1%, P95 > 250ms
```

## Key Rules

1. **Speed is essential** — Every second of bad code costs users
2. **Health checks before rollout** — Never drive blind
3. **Rollback is not failure** — It's showing good judgment
4. **Measure twice, deploy once** — More time in pre-deploy saves you in ops

## Principle

A good deployment is invisible to users. They never notice it happened.
