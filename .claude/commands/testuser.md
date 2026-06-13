Create or log in the local test user `testing@env.local` via the magic-link flow.

Run the script and show me the output:

```bash
bash scripts/testuser.sh
```

The script does three steps:
1. `GET /api/v1/user/send-magic-link?email=testing%40env.local&createUserIfMissing=true`
   — sends the magic link email (creates the user on the first run)
2. Reads the newest file in `logs/email/` and extracts the token
3. `GET /api/v1/user/verify-email?token=<TOKEN>`
   — marks the email as verified and returns a session JWT

After running, print the full JSON response and the extracted JWT token on its own line so I can copy-paste it.

If the server is not running, say so and tell me to start it first.
If `logs/email/` is empty, remind me to set `SMTP_HOST=console.localhost` in the `.env`.
