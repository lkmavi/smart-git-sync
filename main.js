var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VaultSync
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_child_process = require("child_process");
var import_node_http = require("node:http");
var DEFAULTS = {
  enabled: false,
  debounceSeconds: 30,
  pullIntervalSeconds: 30,
  commitTemplate: "auto: sync {date}",
  branch: "main",
  pullOnStartup: false,
  webhookPort: 0,
  webhookSecret: "",
  gitignoreObsidian: true,
  gitignoreOS: true,
  gitignoreIDE: true,
  gitignoreExtra: ""
};
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    (0, import_child_process.execFile)("git", args, { cwd }, (err, stdout, stderr) => {
      if (err)
        reject(new Error(stderr.trim() || err.message));
      else
        resolve(stdout.trim());
    });
  });
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
var VaultSync = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.debounceTimer = 0;
    this.pauseTimer = 0;
    this.pausedUntil = null;
    this.syncing = false;
    this.lastSyncedAt = null;
    this.pullIntervalTimer = 0;
    this.webhookServer = null;
  }
  async onload() {
    await this.loadSettings();
    this.ribbonEl = this.addRibbonIcon(
      this.settings.enabled ? "cloud-upload" : "cloud-off",
      "Smart Git Sync",
      () => new VaultSyncActionsModal(this.app, this).open()
    );
    this.statusBarEl = this.addStatusBarItem();
    this.refreshStatusBar();
    this.registerCommands();
    this.registerVaultEvents();
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
    if (this.settings.enabled && this.settings.pullOnStartup) {
      await this.fetchAndPullIfBehind();
    }
    this.startPollInterval();
    this.startWebhookServer();
  }
  onunload() {
    this.clearDebounce();
    if (this.pauseTimer)
      window.clearTimeout(this.pauseTimer);
    this.stopPollInterval();
    this.stopWebhookServer();
  }
  // ─── Public controls ───────────────────────────────────────────────────────
  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.setRibbonIcon(this.settings.enabled ? "cloud-upload" : "cloud-off");
    this.refreshStatusBar();
    new import_obsidian.Notice(`Smart Git Sync ${this.settings.enabled ? "enabled" : "disabled"}`);
    this.startPollInterval();
  }
  pause(ms) {
    if (this.pauseTimer)
      window.clearTimeout(this.pauseTimer);
    this.pausedUntil = new Date(Date.now() + ms);
    this.pauseTimer = window.setTimeout(() => this.resume(), ms);
    this.clearDebounce();
    this.refreshStatusBar();
    new import_obsidian.Notice(`Smart Git Sync paused until ${this.formatTime(this.pausedUntil)}`);
  }
  resume() {
    if (this.pauseTimer)
      window.clearTimeout(this.pauseTimer);
    this.pausedUntil = null;
    this.refreshStatusBar();
    new import_obsidian.Notice("Smart Git Sync resumed");
  }
  async syncNow() {
    this.clearDebounce();
    await this.sync();
  }
  async pullNow() {
    new import_obsidian.Notice("Smart Git Sync: checking remote\u2026");
    try {
      const updated = await this.fetchAndPullIfBehind();
      new import_obsidian.Notice(updated ? "Smart Git Sync: pulled new changes" : "Smart Git Sync: already up to date");
      if (updated)
        this.refreshStatusBar("synced");
    } catch (err) {
      new import_obsidian.Notice(`Smart Git Sync pull failed:
${errMsg(err)}`, 6e3);
      this.refreshStatusBar("error");
    }
  }
  async initRepo() {
    const cwd = this.vaultPath();
    try {
      await git(cwd, ["init"]);
      new import_obsidian.Notice("Smart Git Sync: git repository initialised");
    } catch (err) {
      new import_obsidian.Notice(`Git init failed:
${errMsg(err)}`, 6e3);
    }
  }
  async setRemote(url) {
    if (!url.trim()) {
      new import_obsidian.Notice("Enter a remote URL first");
      return;
    }
    const cwd = this.vaultPath();
    try {
      try {
        await git(cwd, ["remote", "set-url", "origin", url.trim()]);
      } catch (e) {
        await git(cwd, ["remote", "add", "origin", url.trim()]);
      }
      new import_obsidian.Notice(`Remote origin \u2192 ${url.trim()}`);
    } catch (err) {
      new import_obsidian.Notice(`Failed to set remote:
${errMsg(err)}`, 6e3);
    }
  }
  async generateGitignore() {
    const adapter = this.app.vault.adapter;
    const configDir = this.app.vault.configDir;
    const sections = [];
    if (this.settings.gitignoreObsidian) {
      sections.push(`# Obsidian
${configDir}/
`);
    }
    if (this.settings.gitignoreOS) {
      sections.push("# OS\n.DS_Store\nThumbs.db\ndesktop.ini\nehthumbs.db\n");
    }
    if (this.settings.gitignoreIDE) {
      sections.push("# IDE\n.idea/\n.vscode/\n*.iml\n.fleet/\n");
    }
    const extra = this.settings.gitignoreExtra.trim();
    if (extra)
      sections.push(`# Custom
${extra}
`);
    const content = sections.join("\n");
    const exists = await adapter.exists(".gitignore");
    await adapter.write(".gitignore", content);
    new import_obsidian.Notice(`.gitignore ${exists ? "updated" : "created"}`);
  }
  // ─── Pull interval ─────────────────────────────────────────────────────────
  startPollInterval() {
    this.stopPollInterval();
    const ms = this.settings.pullIntervalSeconds * 1e3;
    if (!this.settings.enabled || ms <= 0)
      return;
    this.pullIntervalTimer = window.setInterval(
      () => {
        void this.scheduledPull();
      },
      ms
    );
  }
  stopPollInterval() {
    if (this.pullIntervalTimer) {
      window.clearInterval(this.pullIntervalTimer);
      this.pullIntervalTimer = 0;
    }
  }
  async scheduledPull() {
    if (!this.settings.enabled || this.isPaused() || this.syncing)
      return;
    try {
      const updated = await this.fetchAndPullIfBehind();
      if (updated) {
        new import_obsidian.Notice("Smart Git Sync: pulled new changes from remote");
        this.refreshStatusBar("synced");
      }
    } catch (err) {
      console.error("[SmartGitSync] scheduled pull failed", err);
      this.refreshStatusBar("error");
    }
  }
  // ─── Webhook server ────────────────────────────────────────────────────────
  startWebhookServer() {
    this.stopWebhookServer();
    const port = this.settings.webhookPort;
    if (!port || port < 1 || port > 65535)
      return;
    this.webhookServer = (0, import_node_http.createServer)((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const secret = this.settings.webhookSecret;
      if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      res.writeHead(202).end("ok");
      void this.pullNow();
    });
    this.webhookServer.on("error", (err) => {
      console.error("[SmartGitSync] webhook error", err);
      new import_obsidian.Notice(`Smart Git Sync webhook error: ${err.message}`, 6e3);
    });
    this.webhookServer.listen(port, "127.0.0.1", () => {
      console.log(`[SmartGitSync] webhook listening on 127.0.0.1:${port}`);
    });
  }
  stopWebhookServer() {
    if (this.webhookServer) {
      this.webhookServer.close();
      this.webhookServer = null;
    }
  }
  // ─── Internal ──────────────────────────────────────────────────────────────
  registerCommands() {
    this.addCommand({ id: "toggle", name: "Toggle auto-sync on/off", callback: () => {
      void this.toggleEnabled();
    } });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => {
      void this.syncNow();
    } });
    this.addCommand({ id: "pull-now", name: "Pull from remote", callback: () => {
      void this.pullNow();
    } });
    this.addCommand({ id: "pause-30m", name: "Pause for 30 minutes", callback: () => this.pause(30 * 60 * 1e3) });
    this.addCommand({ id: "pause-1h", name: "Pause for 1 hour", callback: () => this.pause(60 * 60 * 1e3) });
    this.addCommand({ id: "pause-2h", name: "Pause for 2 hours", callback: () => this.pause(2 * 60 * 60 * 1e3) });
    this.addCommand({ id: "resume", name: "Resume sync", callback: () => this.resume() });
  }
  registerVaultEvents() {
    const trigger = () => this.onVaultChange();
    this.registerEvent(this.app.vault.on("modify", trigger));
    this.registerEvent(this.app.vault.on("create", trigger));
    this.registerEvent(this.app.vault.on("delete", trigger));
    this.registerEvent(this.app.vault.on("rename", trigger));
  }
  onVaultChange() {
    if (!this.settings.enabled || this.isPaused())
      return;
    if (this.settings.debounceSeconds === 0)
      return;
    this.clearDebounce();
    this.debounceTimer = window.setTimeout(
      () => {
        void this.sync();
      },
      this.settings.debounceSeconds * 1e3
    );
    this.refreshStatusBar("pending");
  }
  async sync() {
    if (this.syncing)
      return;
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
      const msg = this.settings.commitTemplate.replace("{date}", this.formatDateTime(/* @__PURE__ */ new Date()));
      await git(cwd, ["commit", "-m", msg]);
      await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
      await git(cwd, ["push", "origin", this.settings.branch]);
      this.lastSyncedAt = /* @__PURE__ */ new Date();
      this.refreshStatusBar("synced");
    } catch (err) {
      console.error("[SmartGitSync]", err);
      new import_obsidian.Notice(`Smart Git Sync failed:
${errMsg(err)}`, 8e3);
      this.refreshStatusBar("error");
    } finally {
      this.syncing = false;
    }
  }
  async fetchAndPullIfBehind() {
    const cwd = this.vaultPath();
    await git(cwd, ["fetch", "origin", this.settings.branch]);
    const local = await git(cwd, ["rev-parse", "HEAD"]);
    const remote = await git(cwd, ["rev-parse", `origin/${this.settings.branch}`]);
    if (local === remote)
      return false;
    await git(cwd, ["pull", "--rebase", "origin", this.settings.branch]);
    return true;
  }
  isPaused() {
    return this.pausedUntil !== null && /* @__PURE__ */ new Date() < this.pausedUntil;
  }
  clearDebounce() {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = 0;
    }
  }
  vaultPath() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof import_obsidian.FileSystemAdapter)
      return adapter.getBasePath();
    throw new Error("Smart Git Sync requires a local vault");
  }
  setRibbonIcon(icon) {
    this.ribbonEl.empty();
    this.ribbonEl.dataset["icon"] = icon;
    this.ribbonEl.setAttribute("aria-label", `Smart Git Sync (${this.settings.enabled ? "on" : "off"})`);
  }
  refreshStatusBar(state) {
    if (!this.settings.enabled) {
      this.statusBarEl.setText("sync: off");
      return;
    }
    if (this.isPaused()) {
      this.statusBarEl.setText(`sync: paused until ${this.formatTime(this.pausedUntil)}`);
      return;
    }
    switch (state) {
      case "pending":
        this.statusBarEl.setText("sync: pending\u2026");
        break;
      case "syncing":
        this.statusBarEl.setText("sync: pushing\u2026");
        break;
      case "synced":
        this.statusBarEl.setText(`sync: ok ${this.formatTime(/* @__PURE__ */ new Date())}`);
        break;
      case "error":
        this.statusBarEl.setText("sync: failed \u2717");
        break;
      default:
        this.statusBarEl.setText("sync: on");
    }
  }
  formatTime(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  formatDateTime(d) {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
  async loadSettings() {
    var _a;
    const data = (_a = await this.loadData()) != null ? _a : {};
    if (data.pullIntervalMinutes !== void 0 && data.pullIntervalSeconds === void 0) {
      data.pullIntervalSeconds = data.pullIntervalMinutes * 60;
      delete data.pullIntervalMinutes;
    }
    this.settings = Object.assign({}, DEFAULTS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var VaultSyncActionsModal = class extends import_obsidian.SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Smart Git Sync \u2014 choose an action");
  }
  getSuggestions() {
    const p = this.plugin;
    const actions = [
      { label: "Sync now \u2014 commit & push immediately", run: () => {
        void p.syncNow();
      } },
      { label: "Pull \u2014 fetch & pull if behind", run: () => {
        void p.pullNow();
      } },
      {
        label: p.settings.enabled ? "Disable auto-sync" : "Enable auto-sync",
        run: () => {
          void p.toggleEnabled();
        }
      }
    ];
    if (p.isPaused()) {
      actions.push({ label: "Resume sync", run: () => p.resume() });
    } else {
      actions.push(
        { label: "Pause for 30 minutes", run: () => p.pause(30 * 60 * 1e3) },
        { label: "Pause for 1 hour", run: () => p.pause(60 * 60 * 1e3) },
        { label: "Pause for 2 hours", run: () => p.pause(2 * 60 * 60 * 1e3) }
      );
    }
    return actions;
  }
  renderSuggestion(action, el) {
    el.createEl("div", { text: action.label });
  }
  onChooseSuggestion(action) {
    action.run();
  }
};
var VaultSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Smart Git Sync").setHeading();
    new import_obsidian.Setting(containerEl).setName("Auto-sync").setDesc("Automatically commit and push on every save").addToggle(
      (t) => t.setValue(this.plugin.settings.enabled).onChange((v) => {
        this.plugin.settings.enabled = v;
        void this.plugin.saveSettings();
        this.plugin.startPollInterval();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Pull on startup").setDesc("Fetch and pull if behind when Obsidian opens").addToggle(
      (t) => t.setValue(this.plugin.settings.pullOnStartup).onChange((v) => {
        this.plugin.settings.pullOnStartup = v;
        void this.plugin.saveSettings();
      })
    );
    this.addDurationSetting(
      containerEl,
      "Push debounce",
      "Wait this long after the last file change before committing. 0 m 0 s = disabled.",
      this.plugin.settings.debounceSeconds,
      (secs) => {
        this.plugin.settings.debounceSeconds = secs;
        void this.plugin.saveSettings();
      }
    );
    this.addDurationSetting(
      containerEl,
      "Pull interval",
      "How often to fetch and pull remote changes. 0 m 0 s = disabled.",
      this.plugin.settings.pullIntervalSeconds,
      (secs) => {
        this.plugin.settings.pullIntervalSeconds = secs;
        void this.plugin.saveSettings();
        this.plugin.startPollInterval();
      }
    );
    new import_obsidian.Setting(containerEl).setName("Commit message").setDesc("{date} \u2192 current date/time").addText(
      (t) => t.setPlaceholder("auto: sync {date}").setValue(this.plugin.settings.commitTemplate).onChange((v) => {
        this.plugin.settings.commitTemplate = v;
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Branch").addText(
      (t) => t.setValue(this.plugin.settings.branch).onChange((v) => {
        this.plugin.settings.branch = v.trim();
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Repository setup").setHeading();
    new import_obsidian.Setting(containerEl).setName("Initialise git repo").setDesc("Run git init in the vault directory").addButton(
      (b) => b.setButtonText("git init").onClick(() => {
        void this.plugin.initRepo();
      })
    );
    let remoteUrlInput = "";
    new import_obsidian.Setting(containerEl).setName("Set remote origin").setDesc("git remote add origin <url>  (or set-url if origin already exists)").addText(
      (t) => t.setPlaceholder("https://github.com/you/vault.git").onChange((v) => {
        remoteUrlInput = v;
      })
    ).addButton(
      (b) => b.setButtonText("Set remote").setCta().onClick(() => {
        void this.plugin.setRemote(remoteUrlInput);
      })
    );
    new import_obsidian.Setting(containerEl).setName(".gitignore").setHeading();
    containerEl.createEl("p", {
      text: "Generate a .gitignore in the vault root. Existing file will be overwritten.",
      cls: "setting-item-description"
    });
    const configDir = this.plugin.app.vault.configDir;
    new import_obsidian.Setting(containerEl).setName(`Ignore ${configDir}/`).setDesc("Obsidian workspace and config files").addToggle(
      (t) => t.setValue(this.plugin.settings.gitignoreObsidian).onChange((v) => {
        this.plugin.settings.gitignoreObsidian = v;
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Ignore OS files").setDesc(".DS_Store, Thumbs.db, desktop.ini\u2026").addToggle(
      (t) => t.setValue(this.plugin.settings.gitignoreOS).onChange((v) => {
        this.plugin.settings.gitignoreOS = v;
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Ignore IDE files").setDesc(".idea/, .vscode/, *.iml, .fleet/\u2026").addToggle(
      (t) => t.setValue(this.plugin.settings.gitignoreIDE).onChange((v) => {
        this.plugin.settings.gitignoreIDE = v;
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Custom entries").setDesc("Additional lines to append (one pattern per line)").addTextArea((t) => {
      t.setPlaceholder("*.log\nsecrets.md\n\u2026");
      t.setValue(this.plugin.settings.gitignoreExtra);
      t.inputEl.rows = 4;
      t.inputEl.setCssStyles({ width: "100%" });
      t.onChange((v) => {
        this.plugin.settings.gitignoreExtra = v;
        void this.plugin.saveSettings();
      });
      return t;
    });
    new import_obsidian.Setting(containerEl).addButton(
      (b) => b.setButtonText("Generate .gitignore").setCta().onClick(() => {
        void this.plugin.generateGitignore();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Webhook").setHeading();
    containerEl.createEl("p", {
      text: "Starts a local HTTP server. POST /sync triggers an immediate fetch + pull. Use Tailscale / cloudflared / ngrok to expose it for GitHub Actions.",
      cls: "setting-item-description"
    });
    new import_obsidian.Setting(containerEl).setName("Webhook port").setDesc("Local port to listen on. 0 = disabled.").addText(
      (t) => t.setPlaceholder("0").setValue(String(this.plugin.settings.webhookPort)).onChange((v) => {
        this.plugin.settings.webhookPort = parseInt(v) || 0;
        void this.plugin.saveSettings();
        this.plugin.startWebhookServer();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Webhook secret").setDesc("Authorization: Bearer <secret>  \u2014 leave empty to disable auth").addText(
      (t) => t.setPlaceholder("leave empty to disable auth").setValue(this.plugin.settings.webhookSecret).onChange((v) => {
        this.plugin.settings.webhookSecret = v;
        void this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Tailscale webhook URL").setDesc("Detect your Tailscale IP to get a ready-to-use webhook URL.").addText((t) => {
      this.webhookUrlText = t;
      t.inputEl.setCssStyles({ width: "280px" });
      t.setPlaceholder("click Detect \u2192");
      t.inputEl.readOnly = true;
      return t;
    }).addButton(
      (b) => b.setButtonText("Detect").onClick(() => {
        void (async () => {
          const ip = await this.detectTailscaleIP();
          if (!ip) {
            new import_obsidian.Notice("Tailscale not found \u2014 is it installed and running?");
            return;
          }
          const port = this.plugin.settings.webhookPort;
          if (!port) {
            new import_obsidian.Notice("Set a Webhook port first");
            return;
          }
          this.webhookUrlText.setValue(`http://${ip}:${port}/sync`);
          new import_obsidian.Notice(`Tailscale IP detected: ${ip}`);
        })();
      })
    ).addButton(
      (b) => b.setButtonText("Copy URL").onClick(() => {
        const url = this.webhookUrlText.getValue();
        if (!url) {
          new import_obsidian.Notice("Detect Tailscale IP first");
          return;
        }
        void navigator.clipboard.writeText(url);
        new import_obsidian.Notice("URL copied to clipboard");
      })
    );
    new import_obsidian.Setting(containerEl).setName("Copy GitHub Actions step").setDesc("Ready-to-paste curl step. Detect URL first.").addButton(
      (b) => b.setButtonText("Copy YAML").onClick(() => {
        var _a;
        const url = (_a = this.webhookUrlText) == null ? void 0 : _a.getValue();
        if (!url) {
          new import_obsidian.Notice("Detect Tailscale URL first");
          return;
        }
        const secret = this.plugin.settings.webhookSecret;
        const authLine = secret ? `              -H "Authorization: Bearer \${{ secrets.VAULT_WEBHOOK_SECRET }}" \\
` : "";
        const yaml = `        - name: Notify Smart Git Sync
          run: |
            curl -fsS -X POST \\
${authLine}              ${url}`;
        void navigator.clipboard.writeText(yaml);
        new import_obsidian.Notice("GitHub Actions step copied to clipboard");
      })
    );
    new import_obsidian.Setting(containerEl).setName("Pause").setHeading();
    new import_obsidian.Setting(containerEl).setName("Pause sync temporarily").addButton((b) => b.setButtonText("30 min").onClick(() => this.plugin.pause(30 * 60 * 1e3))).addButton((b) => b.setButtonText("1 hour").onClick(() => this.plugin.pause(60 * 60 * 1e3))).addButton((b) => b.setButtonText("2 hours").onClick(() => this.plugin.pause(2 * 60 * 60 * 1e3))).addButton((b) => b.setButtonText("Resume").setCta().onClick(() => this.plugin.resume()));
    new import_obsidian.Setting(containerEl).setName("Manual").setHeading();
    new import_obsidian.Setting(containerEl).setName("Sync now").setDesc("Commit and push immediately").addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => {
      void this.plugin.syncNow();
    }));
    new import_obsidian.Setting(containerEl).setName("Pull now").setDesc("Fetch and pull if behind").addButton((b) => b.setButtonText("Pull").onClick(() => {
      void this.plugin.pullNow();
    }));
    this.renderGuide(containerEl);
  }
  // ─── Duration input (min + sec) ──────────────────────────────────────────
  addDurationSetting(containerEl, name, desc, totalSeconds, onSave) {
    let mins = Math.floor(totalSeconds / 60);
    let secs = totalSeconds % 60;
    const setting = new import_obsidian.Setting(containerEl).setName(name).setDesc(desc);
    setting.addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "0";
      t.inputEl.setCssStyles({ width: "55px", textAlign: "center" });
      t.setValue(String(mins));
      t.onChange((v) => {
        mins = Math.max(0, parseInt(v) || 0);
        onSave(mins * 60 + secs);
      });
      return t;
    });
    setting.controlEl.createSpan({ text: " min " });
    setting.addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "0";
      t.inputEl.max = "59";
      t.inputEl.setCssStyles({ width: "55px", textAlign: "center" });
      t.setValue(String(secs));
      t.onChange((v) => {
        secs = Math.max(0, Math.min(59, parseInt(v) || 0));
        onSave(mins * 60 + secs);
      });
      return t;
    });
    setting.controlEl.createSpan({ text: " sec" });
  }
  // ─── Tailscale detection ─────────────────────────────────────────────────
  detectTailscaleIP() {
    return new Promise((resolve) => {
      (0, import_child_process.execFile)("tailscale", ["ip", "-4"], {}, (err, stdout) => {
        var _a;
        if (err)
          resolve(null);
        else
          resolve((_a = stdout.trim().split("\n")[0]) != null ? _a : null);
      });
    });
  }
  // ─── Setup guide ────────────────────────────────────────────────────────
  renderGuide(containerEl) {
    new import_obsidian.Setting(containerEl).setName("Setup guide").setHeading();
    this.guide(containerEl, "First-time setup", `
If your vault is not yet a git repo:

  1. Click "git init" in Repository setup.
  2. Configure .gitignore toggles and click Generate .gitignore.
  3. Create an empty repo on GitHub (no README, no license).
  4. Paste the clone URL into "Set remote origin" and click Set remote.
  5. Run an initial push from a terminal:
       git add . && git commit -m "init" && git push -u origin main
  6. Enable Auto-sync \u2014 the plugin takes over from here.

Tip: keep "Ignore ${this.plugin.app.vault.configDir}/" on if you don't want to sync
Obsidian settings across devices; turn it off if you do.`);
    this.guide(containerEl, "How sync works", `
Auto-sync and Pull interval are off by default \u2014 enable them once your
repo is set up and you're ready.

Push debounce = 0 m 0 s  \u2192  auto-push is disabled (manual Sync now only).
Pull interval = 0 m 0 s  \u2192  background pull is disabled.

When auto-push is active, every file save starts a debounce timer.
When it fires:

  1. git add .
  2. git commit -m "auto: sync <timestamp>"
  3. git pull --rebase origin <branch>   \u2190 absorbs remote changes
  4. git push origin <branch>

If pull --rebase hits a real conflict, sync fails and a Notice appears.
Resolve the conflict in a terminal, then use Sync now from the ribbon menu.`);
    this.guide(containerEl, "Pull interval \u2014 how it works", `
On every tick the plugin runs:

  git fetch origin <branch>           \u2190 updates origin/<branch> ref
  compare HEAD vs origin/<branch>
  \u2192 if equal:  nothing (no notice, no pull)
  \u2192 if behind: git pull --rebase      \u2190 then shows a Notice

This means the pull only happens when there are actual new commits.
The fetch itself is read-only and does not touch your working tree.`);
    this.guide(containerEl, "Webhook \u2014 local trigger", `
Set a Webhook port (e.g. 27123) to start a local HTTP server.
POST /sync triggers an immediate fetch + pull.

  curl -X POST http://127.0.0.1:27123/sync

With a secret:

  curl -X POST http://127.0.0.1:27123/sync \\
    -H "Authorization: Bearer your-secret"

The server responds 202 immediately; the pull runs in the background.`);
    this.guide(containerEl, "Webhook \u2014 GitHub Actions via Tailscale", `
1. Install Tailscale on your machine.
2. Set a Webhook port above, then click Detect.
   The plugin finds your Tailscale IP and fills in the URL.
3. Click Copy URL \u2192 save as VAULT_WEBHOOK_URL in repo secrets.
4. If you set a Webhook secret \u2192 save as VAULT_WEBHOOK_SECRET too.
5. Click Copy GitHub Actions step \u2192 paste into your workflow.

Full workflow (.github/workflows/notify-vault.yml):

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

        - name: Notify Smart Git Sync
          run: |
            curl -fsS -X POST \\
              -H "Authorization: Bearer \${{ secrets.VAULT_WEBHOOK_SECRET }}" \\
              \${{ secrets.VAULT_WEBHOOK_URL }}`);
    this.guide(containerEl, "Webhook \u2014 GitHub Actions via cloudflared / ngrok", `
If you don't use Tailscale, expose the port with a tunnel:

  cloudflared tunnel --url http://127.0.0.1:27123
  # or
  ngrok http 127.0.0.1:27123

Copy the generated public URL, save as VAULT_WEBHOOK_URL in repo secrets:

  - name: Notify Smart Git Sync
    run: |
      curl -fsS -X POST \\
        -H "Authorization: Bearer \${{ secrets.VAULT_WEBHOOK_SECRET }}" \\
        \${{ secrets.VAULT_WEBHOOK_URL }}/sync

Note: cloudflared / ngrok URLs change on restart unless you use a paid
named tunnel. For a stable URL, Tailscale is the better choice.`);
  }
  guide(containerEl, title, body) {
    const details = containerEl.createEl("details");
    details.setCssStyles({ marginBottom: "8px" });
    const summary = details.createEl("summary");
    summary.setCssStyles({ cursor: "pointer", fontWeight: "500" });
    summary.setText(title);
    const pre = details.createEl("pre");
    pre.setCssStyles({
      fontSize: "12px",
      lineHeight: "1.5",
      padding: "10px 12px",
      background: "var(--background-secondary)",
      borderRadius: "6px",
      overflowX: "auto",
      whiteSpace: "pre-wrap",
      marginTop: "6px"
    });
    pre.setText(body.trim());
  }
};
