# Week 7 Revision (Maths + Science)

Year 8 exam revision with accounts. You make an account, choose a subject, and your progress (practice scores, booklet marks, checklist, flashcards, exam history) is saved to your account so it follows you to any device.

- **Maths:** ready. Notes, unlimited auto-marked practice, the full revision booklet with answers, exam mode, interactive tools and a step-by-step solver.
- **Science:** coming soon (the page and account support are already in place).

It runs on **Cloudflare Workers** (the website + a small API) with a **Cloudflare D1** database (accounts and progress). Both are free for this size of site.

## How it works

| Path | What it is |
| --- | --- |
| `public/index.html` | Log in / create account, then pick a subject |
| `public/maths/` | The maths revision site (built from `src/maths/`) |
| `public/science/` | Science placeholder |
| `src/worker.js` | API: sign up, log in, log out, save/load progress, change password, delete account |
| `migrations/0001_init.sql` | Database tables: `users`, `sessions`, `progress` |

Accounts are a username and password only, with no email or other personal details. Passwords are stored as salted PBKDF2 hashes, logins use an HttpOnly cookie, and an account locks for 5 minutes after 8 wrong passwords. There is no password reset (there is no email), so write your password down.

## Put it online (one-time setup)

You need a free Cloudflare account: <https://dash.cloudflare.com/sign-up>.

### Option A: from a computer with Node.js

1. `npm install`
2. `npx wrangler login` (opens Cloudflare in your browser)
3. `npx wrangler d1 create revision-db`, then copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_DATABASE_ID`).
4. `npm run deploy`

It prints your site's address, like `https://revision-hub.<your-name>.workers.dev`.

### Option B: automatic deploys from GitHub

1. Do step 3 above once (or create the database in the Cloudflare dashboard under **Storage & Databases → D1** and copy its ID into `wrangler.toml`).
2. In Cloudflare, create an API token (**My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template, and add **Account → D1 → Edit**).
3. In this GitHub repo, go to **Settings → Secrets and variables → Actions** and add `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (shown on the Cloudflare dashboard home page).
4. Push to `main`. The **Deploy to Cloudflare** action sets up the database tables and publishes the site.

## Working on it

- `npm run dev`: runs the whole site locally at <http://localhost:8787> with a local database.
- Edit the maths content in `src/maths/` (`data.js` has notes, the booklet, flashcards and glossary; `engine.js` has the question generators), then run `npm run build` to rebuild `public/maths/`.
