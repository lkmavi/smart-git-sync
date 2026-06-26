import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
} from "obsidian";
import { execFile } from "child_process";
import type { Server } from "http";

// ─── Settings ────────────────────────────────────────────────────────────────

interface VaultSyncSettings {
  enabled: boolean;
  debounceSeconds: number;
  commitTemplate: string;
  branch: string;
  pullOnStartup: boolean;
  pullIntervalMinutes: number;
  webhookPort: number;
  webhookSecret: string;
}

const DEFAULTS: VaultSyncSettings = {
  enabled: true,
  debounceSeconds: 30,
  commitTemplate: "auto: sync {date}",
  branch: "main",
  pullOnStartup: true,
  pullIntervalMinutes: 5,
  webhookPort: 0,
  webhookSecret: "",
};

// ─── Git helper ──────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class VaultSync extends Plugin {
  settings: VaultSyncSettings;

  private statusBarEl: HTMLElement;
  private ribbonEl: HTMLElement;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedUntil: Date | null = null;
  private syncing = false;
  private lastSyncedAt: Date | null = null;
  private pullIntervalTimer: ReturnType<typeof setInterval> | null = null;
  private webhookServer: Server | null = null;

  async onload() {
    await this.loadSettings();

    this.ribbonEl = this.addRibbonIcon(
      this.settings.enabled ? "cloud-upload" : "cloud-off",
      "Vault Sync",
      () => new VaultSyncActionsModal(this.app, this).open()
    );

    this.statusBarEl = this.addStatusBarItem();
    this.refreshStatusBar();

    this.registerCommands();
    this.registerVaultEvents();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    if (this.settings.enabled && this.settings.pullOnStartup) {
      await this.pullRemote();
    }

    this.startPollInterval();
    this.startWebhookServer();
  }

  onunload() {
    this.clearDebounce();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.stopPollInterval();
    this.stopWebhookServer();
  }

  // ─── Public controls ───────────────────────────────────────────────────────

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.setRibbonIcon(this.settings.enabled ? "cloud-upload" : "cloud-off");
    this.refreshStatusBar();
    new Notice(`Vault Sync ${this.settings.enabled ? "enabled" : "disabled"}`);
    this.startPollInterval();
  }

  pause(ms: number) {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pausedUntil = new Date(Date.now() + ms);
    this.pauseTimer = setTimeout(() => this.resume(), ms);
    this.clearDebounce();
    this.refreshStatusBar();
    new Notice(`Vault Sync paused until ${this.formatTime(this.pausedUntil)}`);
  }

  resume() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pausedUntil = null;
    this.refreshStatusBar();
    new Notice("Vault Sync resumed");
  }

  async syncNow() {
    this.clearDebounce();
    await this.sync();
  }

  async pullNow() {
    new Notice("Vault Sync: pulling…");
    try {
      const updated = await this.pullRemote();
      new Notice(updated ? "Vault Sync: pulled new changes" : "Vault Sync: already up to date");
      if (updated) this.refreshStatusBar("synced");
    } catch (err) {
      new Notice(`Vault Sync pull failed:\n${(err as Error).message}`, 6000);
      this.refreshStatusBar("error");
    }
  }

  // ─── Pull interval ─────────────────────────────────────────────────────────

  startPollInterval() {
    this.stopPollInterval();
    const ms = this.settings.pullIntervalMinutes * 60 * 1000;
    if (!this.settings.enabled || ms <= 0) return;
    this.pullIntervalTimer = setInterval(() => this.scheduledPull(), ms);
  }

  stopPollInterval() {
    if (this.pullIntervalTimer) {
      clearInterval(this.pullIntervalTimer);
      this.pullIntervalTimer = null;
    }
  }

  private async scheduledPull() {
    if (!this.settings.enabled || this.isPaused() || this.syncing) return;
    try {
      const updated = await this.pullRemote();
      if (updated) {
        new Notice("Vault Sync: pulled new changes from remote");
        this.refreshStatusBar("synced");
      }
    } catch (err) {
      console.error("[VaultSync] scheduled pull failed", err);
      this.refreshStatusBar("error");
    }
  }

  // ─── Webhook server ────────────────────────────────────────────────────────

  startWebhookServer() {
    this.stopWebhookServer();
    const port = this.settings.webhookPort;
    if (!port || port < 1 || port > 65535) return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require("node:http") as typeof import("http");

    this.webhookServer = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      const secret = this.settings.webhookSecret;
      if (secret) {
        const auth = req.headers["authorization"] ?? "";
        if (auth !== `Bearer ${secret}`) {
          res.writeHead(401).end("Unauthorized");
          return;
        }
      }

      res.writeHead(202).end("ok");
      this.pullNow();
    });

    this.webhookServer.on("error", (err: Error) => {
      console.error("[VaultSync] webhook error", err);
      new Notice(`Vault Sync webhook error: ${err.message}`, 6000);
    });

    this.webhookServer.listen(port, "127.0.0.1", () => {
      console.log(`[VaultSync] webhook listening on 127.0.0.1:${port}`);
    });
  }

  stopWebhookServer() {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private registerCommands() {
    this.addCommand({
      id: "toggle",
      name: "Toggle auto-sync on/off",
      callback: () => this.toggleEnabled(),
    });
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.syncNow(),
    });
    this.addCommand({
      id: "pull-now",
      name: "Pull from remote",
      callback: () => this.pullNow(),
    });
    this.addCommand({
      id: "pause-30m",
      name: "Pause for 30 minutes",
      callback: () => this.pause(30 * 60 * 1000),
    });
    this.addCommand({
      id: "pause-1h",
      name: "Pause for 1 hour",
      callback: () => this.pause(60 * 60 * 1000),
    });
    this.addCommand({
      id: "pause-2h",
      name: "Pause for 2 hours",
      callback: () => this.pause(2 * 60 * 60 * 1000),
    });
    this.addCommand({
      id: "resume",
      name: "Resume sync",
      callback: () => this.resume(),
    });
  }

  private registerVaultEvents() {
    const trigger = () => this.onVaultChange();
    this.registerEvent(this.app.vault.on("modify", trigger));
    this.registerEvent(this.app.vault.on("create", trigger));
    this.registerEvent(this.app.vault.on("delete", trigger));
    this.registerEvent(this.app.vault.on("rename", trigger));
  }

  private onVaultChange() {
    if (!this.settings.enabled || this.isPaused()) return;
    this.clearDebounce();
    this.debounceTimer = setTimeout(
      () => this.sync(),
      this.settings.debounceSeconds * 1000
    );
    this.refreshStatusBar("pending");
  }

  private async sync() {
    if (this.syncing) return;
    this.syncing = true;
    this.refreshStatusBar("syncing");

    const cwd = this.vaultPath();
    try {
      await git(cwd, ["add", "."]);

      const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
      if (!staged) {
        this.refreshStatusBar("synced");
        return;
      }

      const msg = this.settings.commitTemplate.replace(
        "{date}",
        this.formatDateTime(new Date())
      );
      await git(cwd, ["commit", "-m", msg]);
      await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
      await git(cwd, ["push", "origin", this.settings.branch]);

      this.lastSyncedAt = new Date();
      this.refreshStatusBar("synced");
    } catch (err) {
      console.error("[VaultSync]", err);
      new Notice(`Vault Sync failed:\n${(err as Error).message}`, 8000);
      this.refreshStatusBar("error");
    } finally {
      this.syncing = false;
    }
  }

  private async pullRemote(): Promise<boolean> {
    const cwd = this.vaultPath();
    const before = await git(cwd, ["rev-parse", "HEAD"]);
    await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
    const after = await git(cwd, ["rev-parse", "HEAD"]);
    return before !== after;
  }

  isPaused(): boolean {
    return this.pausedUntil !== null && new Date() < this.pausedUntil;
  }

  private clearDebounce() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error("VaultSync requires a local vault");
  }

  private setRibbonIcon(icon: string) {
    this.ribbonEl.empty();
    (this.ribbonEl as any).dataset.icon = icon;
    this.ribbonEl.setAttribute("aria-label", `Vault Sync (${this.settings.enabled ? "on" : "off"})`);
  }

  private refreshStatusBar(
    state?: "pending" | "syncing" | "synced" | "error"
  ) {
    if (!this.settings.enabled) {
      this.statusBarEl.setText("sync: off");
      return;
    }
    if (this.isPaused()) {
      this.statusBarEl.setText(`sync: paused until ${this.formatTime(this.pausedUntil!)}`);
      return;
    }
    switch (state) {
      case "pending":
        this.statusBarEl.setText("sync: pending…");
        break;
      case "syncing":
        this.statusBarEl.setText("sync: pushing…");
        break;
      case "synced":
        this.statusBarEl.setText(`sync: ok ${this.formatTime(new Date())}`);
        break;
      case "error":
        this.statusBarEl.setText("sync: failed ✗");
        break;
      default:
        this.statusBarEl.setText("sync: on");
    }
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  private formatDateTime(d: Date): string {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Actions modal ───────────────────────────────────────────────────────────

interface SyncAction {
  label: string;
  run: () => void;
}

class VaultSyncActionsModal extends SuggestModal<SyncAction> {
  private plugin: VaultSync;

  constructor(app: App, plugin: VaultSync) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Vault Sync — choose an action");
  }

  getSuggestions(): SyncAction[] {
    const p = this.plugin;
    const actions: SyncAction[] = [
      { label: "Sync now — commit & push immediately", run: () => p.syncNow() },
      { label: "Pull — fetch latest from remote", run: () => p.pullNow() },
      {
        label: p.settings.enabled ? "Disable auto-sync" : "Enable auto-sync",
        run: () => p.toggleEnabled(),
      },
    ];

    if (p.isPaused()) {
      actions.push({ label: "Resume sync", run: () => p.resume() });
    } else {
      actions.push(
        { label: "Pause for 30 minutes", run: () => p.pause(30 * 60 * 1000) },
        { label: "Pause for 1 hour", run: () => p.pause(60 * 60 * 1000) },
        { label: "Pause for 2 hours", run: () => p.pause(2 * 60 * 60 * 1000) }
      );
    }

    return actions;
  }

  renderSuggestion(action: SyncAction, el: HTMLElement) {
    el.createEl("div", { text: action.label });
  }

  onChooseSuggestion(action: SyncAction) {
    action.run();
  }
}

// ─── Settings tab ────────────────────────────────────────────────────────────

class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSync;

  constructor(app: App, plugin: VaultSync) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sync" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically commit and push on every save")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.startPollInterval();
        })
      );

    new Setting(containerEl)
      .setName("Pull on startup")
      .setDesc("Pull latest changes when Obsidian opens")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullOnStartup).onChange(async (v) => {
          this.plugin.settings.pullOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Pull interval (minutes)")
      .setDesc("Periodically pull remote changes. 0 = disabled.")
      .addSlider((s) =>
        s
          .setLimits(0, 60, 1)
          .setValue(this.plugin.settings.pullIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.pullIntervalMinutes = v;
            await this.plugin.saveSettings();
            this.plugin.startPollInterval();
          })
      );

    new Setting(containerEl)
      .setName("Debounce (seconds)")
      .setDesc("How long to wait after the last change before syncing")
      .addSlider((s) =>
        s
          .setLimits(5, 300, 5)
          .setValue(this.plugin.settings.debounceSeconds)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.debounceSeconds = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc("{date} → current date/time")
      .addText((t) =>
        t
          .setPlaceholder("auto: sync {date}")
          .setValue(this.plugin.settings.commitTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitTemplate = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t.setValue(this.plugin.settings.branch).onChange(async (v) => {
          this.plugin.settings.branch = v.trim();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Webhook" });
    containerEl.createEl("p", {
      text: "Starts a local HTTP server. Send POST /sync to trigger a pull. " +
        "Use ngrok / cloudflared / Tailscale to expose it for GitHub Actions.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Webhook port")
      .setDesc("Local port to listen on. 0 = disabled. Restarts on change.")
      .addText((t) =>
        t
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.webhookPort))
          .onChange(async (v) => {
            const port = parseInt(v) || 0;
            this.plugin.settings.webhookPort = port;
            await this.plugin.saveSettings();
            this.plugin.startWebhookServer();
          })
      );

    new Setting(containerEl)
      .setName("Webhook secret")
      .setDesc("Optional Bearer token. Sent as Authorization: Bearer <secret>.")
      .addText((t) =>
        t
          .setPlaceholder("leave empty to disable auth")
          .setValue(this.plugin.settings.webhookSecret)
          .onChange(async (v) => {
            this.plugin.settings.webhookSecret = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Pause" });

    new Setting(containerEl)
      .setName("Pause sync temporarily")
      .addButton((b) =>
        b.setButtonText("30 min").onClick(() => this.plugin.pause(30 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("1 hour").onClick(() => this.plugin.pause(60 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("2 hours").onClick(() => this.plugin.pause(2 * 60 * 60 * 1000))
      )
      .addButton((b) =>
        b.setButtonText("Resume").setCta().onClick(() => this.plugin.resume())
      );

    containerEl.createEl("h3", { text: "Manual" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Commit and push immediately")
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => this.plugin.syncNow())
      );

    new Setting(containerEl)
      .setName("Pull now")
      .setDesc("Pull latest changes from remote")
      .addButton((b) =>
        b.setButtonText("Pull").onClick(() => this.plugin.pullNow())
      );

    this.renderGuide(containerEl);
  }

  private renderGuide(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Setup guide" });

    this.guide(containerEl, "How sync works", `
Every file save starts a debounce timer (default 30 s). When it fires:

  1. git add .
  2. git commit -m "auto: sync <timestamp>"
  3. git pull --rebase origin <branch>   ← absorbs remote changes first
  4. git push origin <branch>

If pull --rebase hits a real conflict, sync fails and a Notice appears.
Resolve the conflict in a terminal, then use Sync now from the ribbon menu.`);

    this.guide(containerEl, "Pull interval", `
When auto-sync is on, the plugin polls git pull --rebase every N minutes
(configured via Pull interval). A notice appears only when there were
actual new commits. The pull is skipped if a sync is already running
or sync is paused.`);

    this.guide(containerEl, "Webhook — local trigger", `
Set a Webhook port (e.g. 27123) to start a local HTTP server.
Send a POST request to trigger a pull:

  curl -X POST http://127.0.0.1:27123/sync

If Webhook secret is set, include it as a Bearer token:

  curl -X POST http://127.0.0.1:27123/sync \\
    -H "Authorization: Bearer your-secret"

The server responds 202 immediately; the pull runs in the background.`);

    this.guide(containerEl, "Webhook — GitHub Actions via Tailscale", `
Tailscale is the easiest way to let GitHub Actions reach your machine.

1. Install Tailscale on your machine and note your Tailscale IP.
2. Add the Tailscale GitHub Action to your workflow.
3. Set VAULT_WEBHOOK_SECRET in your repo secrets.

.github/workflows/notify-vault.yml:

  on:
    push:
      branches: [main]

  jobs:
    notify:
      runs-on: ubuntu-latest
      steps:
        - uses: tailscale/github-action@v2
          with:
            authkey: \${{ secrets.TAILSCALE_AUTHKEY }}

        - name: Notify Vault Sync
          run: |
            curl -fsS -X POST \\
              -H "Authorization: Bearer \${{ secrets.VAULT_WEBHOOK_SECRET }}" \\
              http://<tailscale-ip>:27123/sync`);

    this.guide(containerEl, "Webhook — GitHub Actions via cloudflared", `
If you don't use Tailscale, expose the port with a cloudflared tunnel:

  cloudflared tunnel --url http://127.0.0.1:27123

Copy the generated *.trycloudflare.com URL and save it as
VAULT_WEBHOOK_URL in your repo secrets, then:

  - name: Notify Vault Sync
    run: |
      curl -fsS -X POST \\
        -H "Authorization: Bearer \${{ secrets.VAULT_WEBHOOK_SECRET }}" \\
        \${{ secrets.VAULT_WEBHOOK_URL }}/sync

ngrok works the same way — just replace the URL.`);
  }

  private guide(containerEl: HTMLElement, title: string, body: string) {
    const details = containerEl.createEl("details");
    details.style.marginBottom = "8px";
    const summary = details.createEl("summary");
    summary.style.cursor = "pointer";
    summary.style.fontWeight = "500";
    summary.setText(title);
    const pre = details.createEl("pre");
    pre.style.cssText =
      "font-size:12px;line-height:1.5;padding:10px 12px;" +
      "background:var(--background-secondary);border-radius:6px;" +
      "overflow-x:auto;white-space:pre-wrap;margin-top:6px";
    pre.setText(body.trim());
  }
}
