# FYP Repo Guide
> Read this before you touch anything. Share with an AI agent if you hit errors.

---

## What this project is

A Next.js web app for comparing PostgreSQL database schemas. The main feature is `/compare` — it connects to two live databases, diffs their schemas, and generates a migration SQL script.

Tech stack: **Next.js 16, React 19, TypeScript, Tailwind CSS, PostgreSQL (pg driver)**

The app lives inside the `my-app/` folder. That's where you run all commands from.

---

## Branch structure

| Branch | Who uses it | Purpose |
|---|---|---|
| `main` | Everyone | Clean, working, shared code. Always pull from here. |
| `Umer-dev` | Umer | Umer's working branch |
| `Cindy-dev` | Cindy | Cindy's working branch |
| `mei-dev` | Mei | Mei's working branch |

**Golden rule: never code directly on `main`. Work on your branch, merge into main when ready.**

All four branches are currently identical — same code, same starting point (as of May 2026).

---

## Folder structure

```
FYP-main-2/
└── my-app/               ← THE APP. Run all commands from inside here.
    ├── app/              ← Pages (compare, versions, scripts, login, dashboard)
    ├── components/       ← Reusable UI pieces (Sidebar, Topbar, etc.)
    ├── lib/              ← Core logic
    │   ├── postgres.ts       ← All database connection + query logic
    │   ├── compare.ts        ← Schema diff algorithm
    │   ├── compare-utils.ts  ← Math helpers (Levenshtein, Jaccard similarity)
    │   ├── generate-sql.ts   ← Builds the migration SQL script
    │   ├── version-detection.ts ← Version detection feature
    │   └── db.ts             ← Auth db helper
    ├── .env.local        ← Your database credentials (NOT on GitHub, do not share)
    ├── package.json
    └── ...
```

---

## First time setup (run once)

```bash
# 1. Clone the repo
git clone https://github.com/UmerNaseer2/FYP.git
cd FYP-main-2/my-app

# 2. Install dependencies
npm install

# 3. Create your env file (ask Umer for the values)
# Create a file called .env.local inside my-app/ with:
DATABASE_URL=postgresql://...

# 4. Run the app
npm run dev
# Open http://localhost:3000
```

---

## Daily workflow

```bash
# Start of day — get latest code from main
git checkout your-branch-name
git pull origin main

# Make your changes, then save them
git add .
git commit -m "what you changed"
git push origin your-branch-name

# When your feature is done and ready to share
git checkout main
git pull origin main
git merge your-branch-name
git push origin main
git checkout your-branch-name
```

---

## Common errors and fixes

### "Your branch is based on origin/X but the upstream is gone"
Your branch was renamed. Fix it by pointing to the new name:
```bash
git branch -u origin/Cindy-dev   # Cindy runs this
git branch -u origin/mei-dev     # Mei runs this
git branch -u origin/Umer-dev    # Umer runs this
```

### "refusing to merge unrelated histories"
```bash
git merge origin/main --allow-unrelated-histories
```

### "npm run dev" crashes or eats all your RAM
- Make sure you're running it from inside `my-app/` not the root folder
- Check there is only ONE `package.json` — it should be at `my-app/package.json`
- If there's one at the root level too, delete it

### Merge conflicts (the `<<<<<<<` markers in files)
Don't panic. Open the file, look for this pattern:
```
<<<<<<< HEAD
your version
=======
their version
>>>>>>> origin/main
```
Pick which version to keep, delete the markers, save. Then:
```bash
git add .
git commit -m "resolve merge conflicts"
```

### "password authentication failed for user postgres"
Your `.env.local` file is missing or has wrong credentials. Ask Umer for the correct `DATABASE_URL` value.

### Port 3000 already in use
```bash
# Find and kill whatever is using it
lsof -ti:3000 | xargs kill
npm run dev
```

### node_modules missing / module not found errors
```bash
npm install
```

---

## What NOT to do

- Do not commit `.env.local` — it has real database passwords
- Do not run `git reset --hard` unless you are 100% sure — it deletes your unsaved work
- Do not push directly to `main` without testing your code first
- Do not delete `package-lock.json` manually

---

## If you're stuck

Paste this whole file + your error message into an AI agent (Claude, ChatGPT, etc.) and say:
> "This is our FYP repo setup. I got this error: [paste error]. How do I fix it?"

The context in this file is enough for it to help you.
