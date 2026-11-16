# DrivePool

One web app over several Google accounts. Connect each Gmail account once and you get:

- one total ("37 GB free of 75 GB") and one file list across all accounts
- uploads that go automatically to the account with the most free space
- folders with the same name in different accounts shown as a single folder
- search, preview, download, rename, move and delete from any phone or laptop browser

It runs on Cloudflare's free plan, so it is online all the time without your PC being on.
Your files stay in your own Google Drives. DrivePool stores only the sign-in tokens for each account.

## Setup

You need Node.js (already installed), a Google account and a free Cloudflare account.

### 1. Create your Google sign-in keys (once, about 10 minutes)

1. Open <https://console.cloud.google.com>, sign in with any one of your accounts and create a new project (any name).
2. Search for **Google Drive API** in the top bar, open it and click **Enable**.
3. Open **Google Auth Platform** (search for it) and click **Get started**. Enter an app name such as `DrivePool` and your email, choose **External**, and finish.
4. In **Audience**, click **Publish app** so the status is **In production**.
   If you leave it on "Testing", Google signs every account out after 7 days.
5. In **Clients**, click **Create client** and choose **Web application**. Under **Authorized redirect URIs** add:
   - `http://localhost:8787/api/oauth/callback`
6. Click **Create** and copy the **Client ID** and **Client secret**.

### 2. Try it on your PC

1. Copy `.dev.vars.example` to `.dev.vars` and fill in a password plus the two values from Google.
2. In this folder run:

   ```
   npm install
   npm run dev
   ```

3. Open <http://localhost:8787>, sign in with your password and click **Add Google account**.

When you connect an account, Google shows "Google hasn't verified this app". That is expected for an app you made yourself: click **Advanced**, then **Go to DrivePool**, and tick the Google Drive permission box.

### 3. Put it online

1. Sign in to Cloudflare (creates the free account if you do not have one):

   ```
   npx wrangler login
   ```

2. Publish. The first run asks you to pick a `workers.dev` name and creates the small database for you:

   ```
   npm run deploy
   ```

   It prints your address, like `https://drivepool.yourname.workers.dev`.

3. Store your three settings. Each command asks you to paste the value:

   ```
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

4. Back in Google Cloud Console, open your client and add a second redirect URI using your own address:
   - `https://drivepool.yourname.workers.dev/api/oauth/callback`

5. Open your address, sign in and connect each Google account. Accounts connected while testing on your PC are separate, so connect them again here.

On your phone, open the address in Chrome or Safari and choose **Add to Home screen** to get it as an app icon.

If `npm run deploy` complains that the KV namespace has no id, run `npx wrangler kv namespace create KV`, copy the id it prints into `wrangler.jsonc` as `"id": "..."` next to `"binding": "KV"`, and deploy again.

## Things to know

- **A file has to fit inside one account.** With 15 GB accounts no single file can be larger than the free space of your emptiest account. Files are not split across accounts.
- **Usable space is less than 15 GB each.** Every account shares its space with its own Gmail and Google Photos.
- **Deleting moves to trash.** Space comes back after you empty that account's trash (the menu next to each account).
- **Google Docs, Sheets and Slides** take no space and open in Google instead of downloading.
- **"Shared with me" files** are not listed, only each account's own My Drive.
- **Keep another copy of anything important.** Google's terms discourage using several free accounts to get around storage limits, and could restrict an account.
- **Use a long password.** It is the only thing between the internet and all connected Drives. Sign-in attempts are limited to 10 a minute, and changing the password signs every device out.

## How it is built

| Part | What it does |
| --- | --- |
| `src/index.js` | Cloudflare Worker: password session, Google sign-in for each account, merged listing, folders, rename, move, trash, download streaming |
| `public/` | The interface (plain HTML, CSS and JavaScript, no build step) |
| `wrangler.jsonc` | Cloudflare settings: the KV store for account tokens and the sign-in rate limit |

Uploads go directly from your browser to Google in 16 MB pieces and resume after a dropped connection, so large files do not pass through Cloudflare. Downloads are streamed through the Worker so they work as ordinary links.
