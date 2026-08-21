# Deploy the NSPA Member Portal

The current setup uses Render for the Node.js application and Supabase for
production data.

## 1. Prepare Supabase

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Run `server/db/supabase-schema.sql`.
4. Create a private Storage bucket named `nspa-files`.

## 2. Create the Render service

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint**.
3. Connect the GitHub repository.
4. Render will read `render.yaml` and create the service.

## 3. Add environment variables

Set these in Render under **Environment**:

```text
APP_BASE_URL=https://your-portal-domain
ADMIN_EMAILS=admin@example.com
DATA_DRIVER=supabase
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_STORAGE_BUCKET=nspa-files
MAILERSEND_API_KEY=...
MAIL_FROM=NSPA <no-reply@prospectors.ns.ca>
WIX_SITE_URL=...
WIX_CLIENT_ID=...
WIX_OAUTH_REDIRECT_URI=https://your-portal-domain/api/auth/wix/callback
ZEFFY_API_KEY=...
ZEFFY_STUDENT_URL=...
ZEFFY_REGULAR_URL=...
ZEFFY_STUDENT_CAMPAIGN_ID=...
ZEFFY_REGULAR_CAMPAIGN_ID=...
```

Render generates `SESSION_SECRET`. Do not change it after launch because doing
so signs everyone out.

Optional Wix event synchronization also needs:

```text
WIX_WEBHOOK_PUBLIC_KEY=...
WIX_APP_ID=...
WIX_APP_SECRET=...
```

Never put API keys in GitHub.

## 4. Connect Wix

In the Wix OAuth client, approve this callback:

```text
https://your-portal-domain/api/auth/wix/callback
```

Point the Wix **Member Portal** button to:

```text
https://your-portal-domain/api/auth/wix?next=/dashboard.html
```

For event synchronization, send Wix event webhooks to:

```text
https://your-portal-domain/api/webhooks/wix-events
```

## 5. Connect Zeffy

Send Zeffy `payment.completed` webhooks to:

```text
https://your-portal-domain/api/webhooks/zeffy
```

Members must pay with the same email used for their Wix account.

## 6. Configure email

1. Verify `prospectors.ns.ca` in MailerSend.
2. Add MailerSend's SPF, DKIM, and Return-Path records in Wix DNS.
3. Do not remove the existing Google Workspace MX records.
4. Create a MailerSend token with sending access.
5. Add `MAILERSEND_API_KEY` and `MAIL_FROM` to Render.

## 7. Deploy and check

Deploy the latest GitHub commit, then visit:

```text
https://your-portal-domain/healthz
```

It should return `"ok": true`.

Run the automated tests before each deployment:

```bash
npm test
```

If deployment fails, check the Render logs first. Missing or incorrect
environment variables are the most common cause.
