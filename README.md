# Daily Order Dispatch SOP

The Uncompromised dispatch SOP as a small web app: the 7 PM batch flow, the daily checklist, the min–max stock check, packing videos, and the completion report. Everyone signs in with one team password and their name.

No dependencies. Needs Node 18 or newer.

## What's in this folder

```
server.js            the server (no dependencies)
public/login.html    sign-in page
public/index.html    the SOP app (flow + checklist, min–max stock, packing videos, report, products)
public/shim.js       small API client used by the app
supabase-setup.sql   run once in Supabase
render.yaml          Render blueprint
railway.json         Railway settings
```

Commit **all** of it, including the `public` folder. Without `public/` the site only shows "Not found". When uploading on GitHub's website, drag the folders in (don't pick single files) so `public/login.html` keeps its folder.

To change the SOP steps, edit the `FLOW` list near the top of the script in `public/index.html`.

## Run locally

```
TEAM_PASSWORD=choose-a-password node server.js
```

Open http://localhost:3000.

## Deploy for free: Render + Supabase

Render's free plan runs the app. Supabase's free plan keeps the data and videos, so nothing is lost when Render restarts the app.

### 1. Supabase (data + videos), about 3 minutes
1. Sign up at supabase.com and create a new project (region: Mumbai). Save the database password somewhere; you won't need it here.
2. Open **SQL Editor → New query**, paste everything from `supabase-setup.sql`, and click **Run**.
3. Open **Project Settings → API**. Copy the **Project URL** and the **service_role** key (click Reveal). Keep the service_role key secret.

### 2. Render (the website), about 3 minutes
1. On render.com: **New → Blueprint**, pick the `SOP-Dispatch-` repo.
2. When asked, fill in:
   - `TEAM_PASSWORD`: the password your team signs in with
   - `SUPABASE_URL`: the Project URL from step 1
   - `SUPABASE_SERVICE_KEY`: the service_role key from step 1
3. Click **Apply**. After about 2 minutes your site is live at `https://sop-dispatch.onrender.com` (or a similar name Render shows you).

### What "free" means here
- The free Render app sleeps after 15 minutes with no visitors. The next visit takes about 50 seconds to wake it, then it's fast again.
- Supabase free gives 500 MB of data and 1 GB of video storage, which is enough for years of checklists and dozens of 1-minute videos. A Supabase project with no activity for 7 days gets paused; daily use keeps it awake.

## Settings (environment variables)

| Variable | Required | What it does |
|---|---|---|
| `TEAM_PASSWORD` | Yes | The password the team signs in with. |
| `SESSION_SECRET` | Recommended | A long random string that signs login cookies. Changing it signs everyone out. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | For free hosting | Store everything in Supabase instead of local files. |
| `DATA_DIR` | Without Supabase | Where checklists, stock counts, products and videos are saved. Point it at a persistent disk or volume. |
| `PORT` | No | Set automatically by the host. |

## Deploy on Railway (paid, no Supabase needed)

1. Push this folder to a GitHub repo.
2. On railway.com: **New Project → Deploy from GitHub repo** and pick the repo.
3. In the service, open **Variables** and add `TEAM_PASSWORD`, `SESSION_SECRET` and `DATA_DIR=/data`.
4. Right-click the service → **Attach volume**, mount path `/data`. Without a volume, all data is wiped on every deploy.
5. **Settings → Networking → Generate domain**. To use your own domain (for example `sop.uncompromised.in`), add it there and create the CNAME record Railway shows you.

## Backups

With Supabase, everything is in the `sop_docs` table and the `sop-videos` bucket. Without it, all data lives in `DATA_DIR`: one JSON file per collection plus a `blobs/` folder with the uploaded videos. Copy that folder to back it up.

## Limits

- Videos: MP4 or WebM, up to 20 MB each.
- Built for one store team. Data is kept in JSON files, which is fine for years of daily checklists.
