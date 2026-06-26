# Vault Sync

Obsidian plugin that keeps your vault in sync with a Git remote. Every save triggers a debounced commit + push. Remote changes are pulled automatically on a configurable interval and can also be triggered on-demand via a local webhook.

## Features

- **Auto-sync** — commit and push after every save (debounced)
- **Conflict-safe push** — `git pull --rebase` runs before every push so remote changes are incorporated automatically
- **Pull interval** — periodically pulls remote changes in the background
- **Webhook trigger** — exposes a local HTTP endpoint so CI/CD jobs can trigger a pull the moment someone pushes
- **Action menu** — click the ribbon icon to get a quick-action menu (sync, pull, pause, toggle)
- **Pause** — suspend sync for 30 min / 1 h / 2 h without disabling it

## Requirements

- Desktop only (uses `git` CLI and the local filesystem)
- `git` must be in `$PATH`

## Installation

1. Copy `main.js` and `manifest.json` into `.obsidian/plugins/vault-sync/`
2. Enable the plugin in **Settings → Community plugins**

## First-time setup

If your vault is not yet a git repository:

1. Open plugin settings → **Repository setup** → click **git init**
2. Go to **.gitignore** section, configure the toggles, and click **Generate .gitignore**
3. Create an empty repo on GitHub (no README, no license)
4. Paste the clone URL into **Set remote origin** → click **Set remote**
5. Run an initial push from a terminal:
   ```bash
   git add . && git commit -m "init" && git push -u origin main
   ```
6. Enable **Auto-sync** — the plugin takes over from here

> **Tip:** keep "Ignore .obsidian/" on if you don't want to sync Obsidian settings across devices; turn it off if you do.

## Settings

| Setting | Default | Description |
|---|---|---|
| Auto-sync | **off** | Commit & push on every save |
| Pull on startup | **off** | Fetch + pull when Obsidian opens |
| Push debounce | 0 min 30 sec | Wait after last change before committing. **0 m 0 s = disabled.** |
| Pull interval | 0 min 30 sec | Background fetch+pull cadence. **0 m 0 s = disabled.** |
| Commit message | `auto: sync {date}` | `{date}` is replaced with current timestamp |
| Branch | `main` | Remote branch to push/pull |
| Webhook port | 0 (off) | Local port for the HTTP trigger endpoint |
| Webhook secret | — | Optional `Authorization: Bearer <secret>` guard |
| Ignore .obsidian/ | on | Include `.obsidian/` in generated .gitignore |
| Ignore OS files | on | `.DS_Store`, `Thumbs.db`, `desktop.ini`… |
| Ignore IDE files | on | `.idea/`, `.vscode/`, `*.iml`, `.fleet/`… |
| Custom entries | — | Extra lines appended to the generated .gitignore |

## How sync works

```
file saved
  └─ debounce (default 30 s)
       └─ git add .
            └─ git diff --cached  (skip if nothing staged)
                 └─ git commit -m "auto: sync <timestamp>"
                      └─ git pull --rebase origin <branch>   ← absorbs remote changes
                           └─ git push origin <branch>
```

If `pull --rebase` hits a real conflict (same lines edited by two people), the sync fails and a Notice is shown. Resolve the conflict manually in a terminal, then use **Sync now** from the ribbon menu.

## Pull interval

On every tick the plugin runs `git fetch origin <branch>` to update the remote ref, then compares `HEAD` vs `origin/<branch>`. A pull only happens when the commits differ — if already up to date, nothing happens and no notice is shown. The fetch + pull is skipped if a sync is already in progress or sync is paused.

## Webhook

The plugin can start a local HTTP server:

```
POST http://127.0.0.1:<port>/sync
Authorization: Bearer <secret>   ← only if secret is set
```

A `202 ok` response is returned immediately; the pull runs in the background.

### Exposing to GitHub Actions

The webhook binds to `127.0.0.1`, so it is not reachable from the internet by default. Use a tunnel to expose it:

**Option A — Tailscale** (recommended for personal vaults)

The plugin can detect your Tailscale IP automatically:

1. Install Tailscale on your machine.
2. Set a **Webhook port** in plugin settings.
3. Click **Detect** — the plugin runs `tailscale ip -4` and fills in the full webhook URL.
4. Click **Copy URL** and save it as `VAULT_WEBHOOK_URL` in your repo secrets.
5. Click **Copy GitHub Actions step** to get a ready-to-paste workflow step.

Full workflow example:

```yaml
# .github/workflows/notify-vault.yml
on:
  push:
    branches: [main]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: tailscale/github-action@v2
        with:
          authkey: ${{ secrets.TAILSCALE_AUTHKEY }}

      - name: Notify Vault Sync
        run: |
          curl -fsS -X POST \
            -H "Authorization: Bearer ${{ secrets.VAULT_WEBHOOK_SECRET }}" \
            ${{ secrets.VAULT_WEBHOOK_URL }}
```

**Option B — cloudflared tunnel**

```bash
cloudflared tunnel --url http://127.0.0.1:<port>
```

Copy the generated `*.trycloudflare.com` URL, add it as `VAULT_WEBHOOK_URL` in your repo secrets, then:

```yaml
- name: Notify Vault Sync
  run: |
    curl -fsS -X POST \
      -H "Authorization: Bearer ${{ secrets.VAULT_WEBHOOK_SECRET }}" \
      ${{ secrets.VAULT_WEBHOOK_URL }}/sync
```

**Option C — ngrok**

```bash
ngrok http 127.0.0.1:<port>
```

Same as cloudflared: copy the forwarding URL and use it in your workflow.

### Local scripts

If you just want to trigger a pull from a script on the same machine:

```bash
curl -X POST http://127.0.0.1:<port>/sync
```

No tunnel needed.

## Ribbon menu actions

Click the cloud icon in the left ribbon to open the action menu:

- **Sync now** — commit & push immediately
- **Pull** — pull latest from remote
- **Enable / Disable auto-sync** — toggle without going to settings
- **Pause 30 min / 1 h / 2 h** — suspend auto-sync temporarily
- **Resume** — shown instead of pause options when sync is paused

## Status bar

| Text | Meaning |
|---|---|
| `sync: on` | Auto-sync enabled, idle |
| `sync: pending…` | Waiting for debounce timer |
| `sync: pushing…` | Commit + push in progress |
| `sync: ok 14:32` | Last push succeeded at 14:32 |
| `sync: failed ✗` | Last operation failed (see Notice for details) |
| `sync: paused until 15:00` | Paused until 15:00 |
| `sync: off` | Auto-sync disabled |

## License

MIT
