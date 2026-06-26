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
- The vault directory must already be a git repo with a configured remote

## Installation

1. Copy `main.js` and `manifest.json` into `.obsidian/plugins/vault-sync/`
2. Enable the plugin in **Settings → Community plugins**

## Settings

| Setting | Default | Description |
|---|---|---|
| Auto-sync | on | Commit & push on every save |
| Pull on startup | on | `git pull --rebase` when Obsidian opens |
| Pull interval | 5 min | Background pull cadence. 0 = disabled. |
| Debounce | 30 s | How long to wait after the last change before syncing |
| Commit message | `auto: sync {date}` | `{date}` is replaced with the current timestamp |
| Branch | `main` | Remote branch to push/pull |
| Webhook port | 0 (off) | Local port for the HTTP trigger endpoint |
| Webhook secret | — | Optional `Authorization: Bearer <secret>` guard |

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

When auto-sync is on, the plugin polls `git pull --rebase` every N minutes. A notice appears only when there were actual new commits. The pull is skipped if a sync is already in progress or sync is paused.

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

Install Tailscale on your machine. The webhook is reachable from any device on your tailnet:

```
POST http://<tailscale-ip>:<port>/sync
```

GitHub Actions can reach it if you add the [Tailscale GitHub Action](https://github.com/tailscale/github-action) to your workflow:

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
            http://<tailscale-ip>:<port>/sync
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
