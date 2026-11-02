# Leave Planner

A small team leave planner: request time off, see who's away on a shared calendar,
and let managers approve or reject requests. Static HTML/JS on GitHub Pages,
data and sign-in on Supabase.

## Features

- Email + password sign-in (Supabase Auth)
- Request annual, sick, personal or unpaid leave, including half days
- Working days counted automatically (weekends and public holidays excluded)
- Annual allowance balance with taken / pending breakdown
- Team calendar showing approved and pending leave
- Manager approvals with "who else is off" and balance context
- Managers set allowances, roles and public holidays
- Overlapping requests blocked; all rules enforced in the database with row level security

The first person to sign up becomes the manager.

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New query**, paste [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. In **Project Settings → API**, copy the **Project URL** and the **anon public** key into [`config.js`](config.js).
4. In **Authentication → URL Configuration**, set **Site URL** to your GitHub Pages URL
   (e.g. `https://<user>.github.io/leave-planner/`) so confirmation emails link back to the app.

### 2. GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` deploys on every push to `main`.

## Run locally

Any static server works:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000 and add `http://localhost:8000` to Supabase's redirect URLs.
