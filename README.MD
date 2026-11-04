# Oggy

A Windows desktop app that runs a team of agents for your code and your day. Press `Ctrl` + `Space` or talk, and Oggy plans the work, hands each step to the right agent in [Switch](https://docs.switchagents.ai/switch-rooms/index.md), asks before anything risky, and reports back on the desktop and in Discord.

Download the installer from [Releases](https://github.com/AymaanPathan/oggy/releases/latest).

## Install Oggy

Oggy works through [Switch](https://docs.switchagents.ai/switch-rooms/index.md), which runs your agents and connects them to Discord. Set up Switch first, then Oggy.

1. **Install Switch Console** ([how](https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console.md)) and open it. Let it **run a server on this PC**.
2. In Switch Console, open **Your Agents** and add the agents Oggy will hand work to, such as a Claude Code agent.
3. Download **Oggy-Setup.exe** from [Releases](https://github.com/AymaanPathan/oggy/releases/latest) and run it.
4. Oggy opens its setup window:
   1. **Connect.** Oggy finds Switch on your PC and adds itself as an agent. You don't copy any key: it signs in with Switch Console's own Admin sign-in.
   2. **Your team.** Tick the agents Oggy may use and pick each one's job (general coder, scout, frontend, backend, tester, reviewer, release, assistant).
   3. **About you.** Your name, your Discord username (Oggy only takes orders from it) and your code folder.
5. In Switch Console, invite Oggy (`oggy.<your-windows-name>`) to a room.
6. Press `Ctrl` + `Space` and tell Oggy what you need.

To change any of it later, right-click Oggy's tray icon and choose **Set up Oggy again…**.

**Switch on another machine** (a team or hosted server): in the setup window choose **Use a different Switch server**, then enter its address and a registration key from its admin page (**API Keys → Create Registration Key**).


---

## Problem: Oggy's Switch API key was pushed to GitHub

**What happened:** `backend/src/config.json` was committed and pushed. It contains Oggy's Switch agent id and API key, the same ones Oggy uses in `C:\Users\<you>\.oggy\config.json`.

### Is it dangerous?

**Not with a local Switch server**, which is what Switch Console sets up by default. That server only answers on `localhost`, so the key works only for programs on your own PC.

Check it yourself in PowerShell:

```powershell
# 1. Works: the server answers on your own PC
Invoke-WebRequest http://localhost:53754/health -UseBasicParsing

# 2. Should fail: the server must NOT answer on your network address
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1).IPAddress
Invoke-WebRequest "http://${ip}:53754/health" -UseBasicParsing -TimeoutSec 3
```

Use the port from `switch.apiUrl` in your `config.json` instead of `53754`.

- If **2 fails**, the leaked key is harmless. Still do **Stop tracking the file**, and replace the key if you want to be thorough.
- If **2 works**, or your `apiUrl` isn't `localhost`, anyone with the key can act as Oggy. Do both sections below now.

### Stop tracking the file

In a terminal in the repo folder:

```bash
git rm --cached backend/src/config.json
echo backend/src/config.json >> .gitignore
git commit -m "Stop tracking local Switch config"
git push
```

`git rm --cached` removes the file from git and keeps your local copy. Keep the real config only in `C:\Users\<you>\.oggy\config.json`. `switch/config.example.json` is the template, with placeholders only.

### Replace the key: Switch Console on your own PC

Switch Console has no button for this yet. It runs a local Switch server for you, and that server keeps its **Admin sign-in** in this file:

`C:\Users\<you>\AppData\Roaming\switchdash\local-switch-server\native\run\switch-core.env`

Oggy belongs to Admin, like every agent you add in Switch Console. The command below:

1. signs in to your local Switch as Admin
2. creates a one-time registration key
3. re-registers Oggy with it, which gives Oggy a **new key** and **kills the old one** (Oggy keeps its id and rooms)
4. saves the new key in `config.json`, keeping the old file as `config.json.bak`
5. deletes the one-time key

Nothing is printed, and if any step fails, it stops and nothing is changed.

**Steps:**

1. Make sure **Switch Console** is running.
2. **Quit Oggy:** click **Quit** at the bottom-left of the app.
3. Open **PowerShell**, paste this whole block, and press Enter:

   ```powershell
   & {
     $ErrorActionPreference = "Stop"
     $vars = @{}
     Get-Content "$env:APPDATA\switchdash\local-switch-server\native\run\switch-core.env" |
       ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $vars[$matches[1]] = $matches[2].Trim('"', "'", ' ') } }
     $cfgPath = "$HOME\.oggy\config.json"
     $cfgText = [IO.File]::ReadAllText($cfgPath)
     $cfg     = $cfgText | ConvertFrom-Json
     $server  = $cfg.switch.apiUrl.TrimEnd('/')

     # 1. Sign in as Admin
     $login = @{ email = $vars.GATEWAY_ADMIN_EMAIL; password = $vars.GATEWAY_ADMIN_PASSWORD } | ConvertTo-Json
     Invoke-RestMethod -Method Post -Uri "$server/gateway/auth/login" -ContentType "application/json" -Body $login -SessionVariable sw | Out-Null

     # 2. One-time registration key
     $reg = Invoke-RestMethod -Method Post -Uri "$server/gateway/api-keys" -ContentType "application/json" -Body '{"label":"oggy-rotate"}' -WebSession $sw
     try {
       # 3. Re-register Oggy: new key, old key dies
       $body = @{
         name = $cfg.switch.agentName; connector_type = "Oggy"; overwrite = $true
         description = "Oggy: voice assistant that plans jobs, runs apps on the laptop and coordinates the agents"
         integration_profile = @{
           connection_model = "always_on"; message_exchange = $true
           pre_invocation_mediation = @(); post_invocation_mediation = @(); event_reporting = @()
           command_capabilities = @{ reset = "unsupported"; compact = "unsupported"; interrupt = "unsupported" }
         }
       } | ConvertTo-Json -Depth 6
       $res = Invoke-RestMethod -Method Post -Uri "$server/agents" -Headers @{ Authorization = "Bearer $($reg.key)" } -ContentType "application/json" -Body $body
       if (-not $res.api_key) { throw "Switch returned no key, so nothing was changed." }

       # 4. Save it
       Copy-Item $cfgPath "$cfgPath.bak" -Force
       [IO.File]::WriteAllText($cfgPath, $cfgText.Replace($cfg.switch.agentApiKey, $res.api_key))
       if ($res.id -ne $cfg.switch.agentId) { Write-Warning "Agent id changed to $($res.id): update switch.agentId in $cfgPath too." }
       "Done. Oggy has a new key and the old one no longer works."
     } finally {
       # 5. Delete the one-time key
       Invoke-RestMethod -Method Delete -Uri "$server/gateway/api-keys/$($reg.id)" -WebSession $sw | Out-Null
     }
   }
   ```

4. You should see `Done. Oggy has a new key and the old one no longer works.`
5. Open **Oggy** again. The bottom-left should say **Connected**.

| Error | Why | Fix |
| - | - | - |
| `Unable to connect to the remote server` | Switch's server isn't running | Open Switch Console, wait for it to start, try again |
| `Invalid email or password` | Switch changed how it stores the Admin sign-in | Nothing was changed. Use **Replace the key: team server** once Switch Console has an API keys page |
| `Agent already exists` | Oggy belongs to a different account than Admin | Nothing was changed. Ask for help |
| `Cannot find path ...switch-core.env` | Switch isn't installed the default way | Nothing was changed. Use **Replace the key: team server** |

`switch-core.env` is how Switch Console works today, not a documented feature, so a Switch update may move it. It holds your Switch server's passwords: never share or commit it.

### Replace the key: team server

A Switch server that isn't run by Switch Console on your own PC (self-hosted, Railway, a remote host) has an admin page:

1. In **Switch Console**, click the server in the sidebar.
2. Under **Full admin interface**, click **Open**.
3. Go to **API Keys**, select **Create Registration Key**, and copy it.
4. In the command above, delete steps 1, 2 and 5. Replace `$($reg.key)` with the key you copied, and run it.
5. Delete the registration key on the **API Keys** page.

Sources: Switch docs on [registering an agent](https://docs.switchagents.ai/switch-rooms/internals/agent-protocol.md#register-the-agent) and [registration keys](https://docs.switchagents.ai/switch-rooms/administer/people-and-agents.md). The Switch server code for version 0.31.0 (`switch-v0.31.0`): `gateway/auth_routes.py` (sign-in), `gateway/api_keys.py` (registration keys), `bridges/agent/protocol/agent_core.py` (re-registering).

---

## Build and release

From `frontend/`:

- `pnpm dist` builds `build/installer/Oggy-Setup.exe`. It bundles the backend, Node 22 and SQLite into the app first (`scripts/pack.mjs`). Run it with Node 22, after `pnpm install` in `backend/` and `frontend/`.
- `pnpm release` builds, then publishes `Oggy-Setup.exe` as a GitHub release named after `version` in `frontend/package.json` (`scripts/release.mjs`, which needs `gh auth login`). Bump the version before each release.
