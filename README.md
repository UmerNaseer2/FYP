# Schema Studio

Compare two PostgreSQL schemas, generate the migration between them, keep it as
a versioned script in GitHub, and apply it to a target database with a ledger
of what ran. A Next.js web app, shipped as one container image.

| To | Read |
|---|---|
| Install and run it beside your own PostgreSQL, with your own Microsoft sign-in | [`deploy/handover/SETUP-GUIDE.md`](deploy/handover/SETUP-GUIDE.md) |
| Run it from the source, and see what is and is not built | [`my-app/README.md`](my-app/README.md) |
| Change the code | [`docs/DEVELOPER-MANUAL.md`](docs/DEVELOPER-MANUAL.md) |
| Every document, in one list | [`docs/README.md`](docs/README.md) |

The application is in [`my-app/`](my-app/). To try it from the source:

```bash
docker compose up -d db
```

```bash
cd my-app && npm ci && cp .env.local.example .env.local && npm run dev
```

Then open `http://localhost:3000`.
