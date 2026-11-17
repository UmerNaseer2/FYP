# Project documents

Where to read about Schema Studio, by what you want to do.

| I want to | Read |
|---|---|
| Set the app up on a machine of my own (Docker, my own PostgreSQL, my own Microsoft sign-in), with one command (`setup.sh`) or step by step | [`deploy/handover/SETUP-GUIDE.md`](../deploy/handover/SETUP-GUIDE.md) |
| Run it on Supabase and Vercel instead | [`deploy/SUPABASE-VERCEL.md`](../deploy/SUPABASE-VERCEL.md) |
| Use the app, screen by screen | [`user-manual/schema-studio-user-manual.txt`](user-manual/schema-studio-user-manual.txt) |
| Change the code: how it is built, where things live, which files a feature touches, the rules it follows | [`DEVELOPER-MANUAL.md`](DEVELOPER-MANUAL.md) |
| Know why the schema reader is raw SQL against the catalog, not an ORM or a library | [`RAW-SQL.md`](RAW-SQL.md) |
| Run it from the source and find my way round the folders | [`my-app/README.md`](../my-app/README.md) |

All of these describe the code as it is on this branch. When one of them and
the code disagree, the code is right and the document is a bug: fix it in the
same change.

## What is not here

Course paperwork (the project plan, the poster, sprint reports, signed forms)
is kept outside this repository. The repository is public, and those carry
names and signatures.
