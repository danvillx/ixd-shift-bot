# 🤖 DBot 1.5 — TEB9 IXD Amazon Shift Operations Bot

Night shift's favorite bot. Q-block reports, ticket tracking, handoffs, and motivation — all in Slack.

---

## Commands

| Command | What it does |
|---|---|
| `/dbot` | Show all commands + status updates to CF Lead |
| `/dbot gtg [note]` | Post GTG status to #teb9-cf-lead |
| `/dbot down [note]` | Post DOWN status |
| `/dbot back-up [note]` | Post Back Up status |
| `/dbot back-in-service [note]` | Post Back in Service |
| `/qreport [notes]` | AI-generated Q-block report |
| `/sos` | Start of shift report (modal form) |
| `/shiftreport` | Full shift handoff report (modal form) |
| `/ticket new` | Create a ticket |
| `/ticket list` | Show open tickets |
| `/ticket TKT-001 resolve` | Resolve a ticket |
| `/ticket TKT-001 status in-progress` | Update ticket status |
| `/ticket TKT-001 note [text]` | Add a note to a ticket |
| `/coffee [note] [@person]` | Drop motivation with context-aware quote |

---

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it `DBot` — pick your workspace
3. Under **Socket Mode** → Enable Socket Mode → Generate App Token with `connections:write` scope → save as `SLACK_APP_TOKEN`
4. Under **OAuth & Permissions** → add these **Bot Token Scopes**:
   - `chat:write`
   - `chat:write.public`
   - `commands`
   - `app_mentions:read`
5. Install app to workspace → copy **Bot User OAuth Token** → save as `SLACK_BOT_TOKEN`
6. Under **Basic Information** → copy **Signing Secret** → save as `SLACK_SIGNING_SECRET`

### 2. Register Slash Commands

Under **Slash Commands** in your app, add each command:

| Command | Description | Usage Hint |
|---|---|---|
| `/dbot` | DBot status updates | `gtg \| down \| back-up [note]` |
| `/qreport` | Q-block report | `[your shift notes]` |
| `/sos` | Start of shift | _(opens modal)_ |
| `/shiftreport` | Shift handoff report | _(opens modal)_ |
| `/ticket` | Ticket management | `new \| list \| TKT-001 resolve` |
| `/coffee` | Motivation drop | `[note] [@person]` |

> Request URL for all commands: use any HTTPS URL (Railway will provide this), or leave blank for Socket Mode.

### 3. Enable Event Subscriptions

Under **Event Subscriptions** → Enable → Subscribe to:
- `app_mention`

### 4. Environment Variables

Copy `.env.example` to `.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
```

### 5. Run Locally

```bash
npm install
npm start
```

---

## Deploy to Railway

### First time setup:

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Link to GitHub repo (recommended)
# Push code to GitHub first, then connect via Railway dashboard

# Set environment variables
railway variables set SLACK_BOT_TOKEN=xoxb-...
railway variables set SLACK_APP_TOKEN=xapp-...
railway variables set SLACK_SIGNING_SECRET=...
railway variables set ANTHROPIC_API_KEY=sk-ant-...

# Deploy
railway up
```

### Via Railway Dashboard (easier):

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Connect your `danvillx/ixd-shift-bot` repo
3. Go to **Variables** tab → add all 4 env vars
4. Railway auto-deploys on every push to `main`

### Check logs:
```bash
railway logs
```

---

## Architecture

```
src/
├── app.js                    # Entry point, Bolt app init
├── commands/
│   ├── coffee.js             # /coffee — motivation drops
│   ├── qreport.js            # /qreport — Q-block AI reports
│   ├── sos.js                # /sos — start of shift modal
│   ├── shiftreport.js        # /shiftreport — handoff modal
│   ├── ticket.js             # /ticket — ticket management
│   └── status.js             # /dbot — status updates
├── prompts/
│   └── buildingContext.js    # TEB9 knowledge injected into all AI calls
└── utils/
    ├── claude.js             # Anthropic API wrapper
    └── ticketStore.js        # In-memory ticket state
```

**Tech stack:** Node.js + Bolt for Slack + Claude Haiku + Socket Mode + Railway

---

## Writing Rules (baked into all AI outputs)

- Say **carriers** not "carrier counts"
- Say **recirc** not "recirculation"  
- Say **high/heavy** not "elevated"
- First person plural: "we started", "we had"
- Never: "environment", "kickoff", "carry this momentum", "required intervention", "managing the flow"
- Never assume XBelt cause, RME involvement, or recirc source unless stated
- No Reads ≠ XBelt stoppages

---

## Changelog

### v1.5 (Current)
- Full modal forms for `/sos` and `/shiftreport`
- `/ticket` system with TKT-XXX IDs, status tracking, notes
- `/dbot` status command posting to #teb9-cf-lead
- `/coffee` with auto grammar fix + context-aware quote selection + LP quotes
- `/qreport` with AI narrative generation
- Building context injected into all Claude calls
- Railway deployment config

### v1.1
- DBot Qreport Slack Workflow (manual workaround during admin approval)
- Isengard attestation form initiated

### v1.0
- Initial bot structure
- Basic Slack Workflow Builder integration
