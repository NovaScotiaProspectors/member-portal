# NSPA Member Portal

The Nova Scotia Prospectors Association member portal manages memberships,
projects, claims, events, notifications, and the prospecting map.

The public website stays on Wix. Wix handles account sign-in, while this portal
handles membership access and member data.

## Main features

- Wix sign-up and sign-in
- Zeffy membership payments
- Member project submissions and Data Room links
- Project editing and owner deletion
- Claim tracking and expiry alerts
- Wix event synchronization and portal registration
- Admin tools for members, projects, email, and backups
- MailerSend email notifications

## Run locally

Requirements: Node.js 22 and npm.

```bash
npm install
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Local development uses files inside `data/` unless Supabase is configured.

## Test

```bash
npm test
```

## Configuration

Keep secrets in `.env` locally and in the hosting provider's environment
settings in production. Never commit `.env` or API keys.

Important settings:

- `SESSION_SECRET` — secures login sessions
- `APP_BASE_URL` — deployed portal address
- `ADMIN_EMAILS` — comma-separated administrator emails
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — production database
- `MAILERSEND_API_KEY` and `MAIL_FROM` — outgoing email
- `WIX_CLIENT_ID` and `WIX_OAUTH_REDIRECT_URI` — Wix sign-in
- `ZEFFY_API_KEY` and campaign IDs — payment verification

See `.env.example` for the complete list.

## Deployment

See [DEPLOY.md](DEPLOY.md) for the production checklist.
