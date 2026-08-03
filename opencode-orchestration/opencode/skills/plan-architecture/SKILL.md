---
name: plan-architecture
description: Architecture planning with explicit decisions, failure modes, and verification plans before implementation.
compatibility: opencode
metadata:
  source: legacy-flat-markdown
---

# Architecture Planning (Engineering Review)

You are an engineering manager locking down the technical approach.

## Goal

Take a feature and produce a decision-grade architecture doc that engineering can execute.

## Questioning Phase

When constraints or decisions are unresolved and only the user can settle them, run the `interrogate-plan` skill — it owns the interview mechanics (one question per message, a recommended answer with every question, repo-answerable facts checked instead of asked, answers recorded before moving on). Do not restate interview instructions here; record each resolved decision as an ADR-lite entry (Section 7).

## Module Depth Check

Read both rule books before committing to a decomposition. `packs/rules/a-philosophy-of-software-design/a-philosophy-of-software-design.mini.md` (~1,400 tokens) supplies the depth and information-hiding rules; `packs/rules/clean-architecture/clean-architecture.mini.md` (~1,400 tokens) supplies dependency direction and boundary placement. Together they settle which of the proposed modules are deep and which are pass-throughs, and which way the arrows between them must point — record the verdict in the ADR-lite entry (Section 7).

Apply this vocabulary to every major component and interface in the design:

- **Depth**: a module's value is behaviour delivered per unit of interface learned. Deep = small interface hiding a lot of behaviour. Shallow = an interface as large as the implementation it wraps.
- **Seams**: name the seams — the boundaries where an implementation can be swapped without callers noticing. Unnamed seams do not exist.
- **The deletion test**: if removing a module makes complexity vanish rather than move, it was a pass-through, not an abstraction. Delete it.
- **One adapter = hypothetical seam, two = real**: a seam with a single implementation behind it is a guess. Build the abstraction when the second concrete implementation exists.
- **Design it twice**: for every major interface, sketch two genuinely different designs before committing, and record why the winner is deeper (in the ADR-lite entry, Section 7).

## Sections

### 1. Data Model

Create an ASCII (Mermaid) diagram showing:

- Core entities and relationships
- Primary keys
- Foreign keys
- Index strategy if relevant

```
User (id, email, created_at)
  ↓ 1-to-many
Project (id, user_id, name)
  ↓ 1-to-many
Task (id, project_id, title, status)
```

### 2. Request Flow

Draw the request path from client → backend → database → response:

```
Client Request
  ↓
API Handler (auth check)
  ↓
Business Logic (validation)
  ↓
Database Query
  ↓
Response (serialize)
```

### 3. Error Paths

What breaks and how do we recover?

```
- Network timeout → Retry with exponential backoff
- Auth failure → 401 + login redirect
- DB error → Log + return 500 with tracking ID
- Invalid input → 400 + field-level errors
```

### 4. State Machine (if applicable)

Show the valid states and transitions:

```
Draft → (user_click_submit) → Pending
Pending → (admin_approve) → Approved
  → (admin_reject) → Draft
Approved → (user_archive) → Archived
```

### 5. Dependencies

List third-party services, libraries, or systems:

```
- Database: PostgreSQL 14+
- Auth: JWT + refresh tokens
- Storage: Local file system (future: S3)
- Email: SendGrid for transactional
```

### 6. Scaling Concerns

Will this scale? If not, what's the plan?

```
- Writes per second acceptable for DB?
- API rate limiting strategy?
- Cache strategy (Redis? Edge?)
- Monitoring/alerts needed?
```

### 7. Architecture Decision Records (ADR-lite)

For each major decision:

```
Decision: [what]
Chosen Option: [A/B/C]
Alternatives: [other options considered]
Trade-offs: [latency, cost, complexity, reliability]
Why now: [reason this is best for current stage]
```

### 8. Observability Plan

Define what must be measured from day one:

```
- Golden signals: latency, traffic, errors, saturation
- Business metric: [example: successful checkout rate]
- Alerts: [threshold and owner]
- Logs/traces: [minimum required fields]
```

### 9. Migration and Rollback Strategy

If schema or behavior changes:

```
- Forward migration steps
- Backward compatibility constraints
- Rollback plan if deployment fails
```

## Failure Mode Analysis

Ask for each component: "What if this fails?"

```
Database down:
  → Graceful degradation or hard fail?
  → Retry strategy
  → Monitoring alert time

API timeout:
  → Circuit breaker? Fallback?
  → User experience

Auth service down:
  → Cache tokens? Hard require?
```

## Output Format

```markdown
# Architecture Document

## Data Model

[Diagram]

## Request/Response Flow

[Diagram]

## Error Handling

[Strategy for each failure mode]

## State Management

[Diagram if stateful]

## Scaling Strategy

[Concerns + mitigation]

## Dependencies

[List of external services]

## Decision Records

[ADR-lite entries for major choices]

## Observability

[Metrics, logs, alerts required]

## Migration/Rollback

[How to deploy safely and recover]

## Verification Plan

- Unit test focus
- Integration test focus
- Manual checks

## Timeline

[Feasible in [timeframe]?]

## Risks

[Technical risks + mitigation]

## Recommendation

[Approved / Needs iteration / Rethink this part]
```

## Required Closing Section

Every architecture output must end with:

```markdown
### Critical Files for Implementation

List 3–5 files most critical for implementing this architecture:

- path/to/file1
- path/to/file2
- path/to/file3
```

If this is a greenfield design, list the files that will anchor the implementation. This section is the primary handoff artifact for the builder — the first files a builder opens when starting work.

## Principle

Good architecture forces hidden assumptions into the open. Diagrams are conversations, not ornaments.
