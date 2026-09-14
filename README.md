# App Clarity Email Sender

Branch `deliverability-v2` modernizes the existing application without changing the current production deployment.

## Safety gates

Sending is disabled unless both `SEND_ENABLED=true` and `SENDER_DOMAIN_VERIFIED=true`. Keep both false until `clarity-access.com` is shown as **Verified** in the correct Resend workspace and the production change is approved.

## Required production configuration

Copy the names from `.env.example` into Railway without committing any secret values. `PUBLIC_APP_URL` should be a branded HTTPS custom domain pointing to the app so unsubscribe links match the Clarity Access brand. `ADMIN_USERNAME` and `ADMIN_PASSWORD` are required to protect every management screen; webhooks and unsubscribe remain public.

## Resend webhook

After deployment approval, register `POST /webhooks/resend` and subscribe to:

- `email.sent`
- `email.delivered`
- `email.opened`
- `email.clicked`
- `email.bounced`
- `email.complained`

Store the endpoint signing secret as `RESEND_WEBHOOK_SECRET`. The handler verifies the raw request using Svix and deduplicates deliveries by `svix-id`.

## DNS and deliverability checklist

- Add exactly the SPF and DKIM records supplied by Resend for `clarity-access.com` and wait for **Verified**.
- Publish DMARC for the organizational domain, start with monitoring (`p=none`) and review reports before moving to quarantine/reject.
- Confirm SPF/DKIM alignment with the visible From domain.
- Use `Clarity Access <support@clarity-access.com>` and the same mailbox as reply-to.
- Serve branded, HTTPS links; do not use shorteners or the Railway URL in email content.
- Keep both HTML and plain-text parts and preserve the visible unsubscribe footer plus one-click headers.
- Warm volume gradually and prioritize delivery/click signals over approximate opens.

## Local verification

```sh
npm ci
npm run check
npm test
```
