# Oggy

A Windows desktop app that runs a team of agents for your code and your day. Press `Ctrl` + `Space` or talk, and Oggy plans the work, hands each step to the right agent in [Switch](https://docs.switchagents.ai/switch-rooms/index.md), asks before anything risky, and reports back on the desktop and in Discord.

Download the installer from [Releases](https://github.com/AymaanPathan/oggy/releases/latest).

---

## Problem: Oggy's Switch API key leaked

Oggy logs in to Switch with two values in `C:\Users\<you>\.oggy\config.json`:

- `switch.agentId`: which agent Oggy is
- `switch.agentApiKey`: Oggy's password

If the key was pushed to GitHub, pasted in a chat, or shared anywhere else, anyone who has it can act as Oggy. Make a new key and kill the old one.

**Good to know first:**

- Switch has **no "regenerate key" button**.
- A key is shown **only once**, when the agent is registered.
- So to get a new key, you **register Oggy again**. That also **revokes the old key** automatically.

---

### Step 1: Make a registration key

This is a separate, one-time key that is only allowed to register agents.

1. Open your Switch server's address in a browser. It's the `switch.apiUrl` value in `config.json`, for example `http://localhost:53754`. This opens the **Gateway**.
2. Sign in as **yourself**.
3. Click **API Keys**.
4. Click **Create Registration Key**.
5. Type a label, for example `oggy-rotate`.
6. Copy the key it shows you.

---

### Step 2: Create Oggy's new key (this revokes the old one)

1. Open **PowerShell**.
2. Paste this, after changing the first 3 lines:

   ```powershell
   $server = "http://localhost:53754"     # your switch.apiUrl
   $regKey = "PASTE-REGISTRATION-KEY"     # from Step 1
   $name   = "oggy"                       # your switch.agentName

   $body = @{
     name                = $name
     description         = "Oggy: plans jobs and hands them to the team's agents"
     connector_type      = "oggy"
     overwrite           = $true
     integration_profile = @{
       connection_model          = "always_on"
       message_exchange          = $true
       pre_invocation_mediation  = @()
       post_invocation_mediation = @()
       event_reporting           = @()
     }
   } | ConvertTo-Json -Depth 5

   Invoke-RestMethod -Method Post -Uri "$server/agents" `
     -Headers @{ Authorization = "Bearer $regKey" } `
     -ContentType "application/json" -Body $body
   ```

3. Press Enter. You get back two values:

   ```text
   id      : 1234abcd-...
   api_key : NEW-KEY-...
   ```

4. **Copy both now.** Switch will never show `api_key` again.

The old key stops working the moment this succeeds, and Oggy stays in all its rooms.

---

### Step 3: Give Oggy the new key

1. Open `C:\Users\<you>\.oggy\config.json` in a text editor.
2. Replace the `agentApiKey` value with the new `api_key`.
3. If `id` is different from `agentId`, replace that too.
4. Save the file.
5. Quit Oggy and open it again.
6. Check that the bottom-left of Oggy says **Connected**.

---

### Step 4: Revoke the registration key

You don't need it anymore, so delete it.

1. Go back to the Gateway's **API Keys** page.
2. Find `oggy-rotate`.
3. Delete it.

---

### Step 5: Make sure the key can't leak again

1. Never put `config.json` inside the repo. The real one belongs only in `C:\Users\<you>\.oggy\`.
2. If a copy was committed, stop tracking it:

```bash
git rm --cached backend/src/config.json
echo backend/src/config.json >> .gitignore
git commit -m "Stop tracking local Switch config"
git push
```

The old key is still visible in the GitHub history, but that's fine now: Step 2 already killed it.

---

### If something goes wrong

| What you see | What it means | What to do |
| - | - | - |
| `401` in Step 2 | The registration key is wrong | Copy it again from **API Keys**, or make a new one |
| `409` in Step 2 | Someone else owns an agent with that name | Use the name in your `switch.agentName`, signed in as the person who created Oggy |
| Oggy says **not connected** after Step 3 | The new key or id wasn't saved correctly | Check `config.json` for typos and extra spaces, then restart Oggy |
| Oggy connects but ignores Rahul or other agents | A newly registered agent answers only its owner | Run the command below |

To let your other agents talk to Oggy again:

```powershell
Invoke-RestMethod -Method Post -Uri "$server/agents/<id>/ops/update_agent_detail" `
  -Headers @{ Authorization = "Bearer <new api_key>" } `
  -ContentType "application/json" `
  -Body '{"agent_id": "<id>", "addressing": "owner_and_owner_agents"}'
```

`addressing` can be `owner_only`, `owner_and_owner_agents` or `anyone`.

---

### Other way: delete Oggy and start over

Use this if Step 2 keeps failing.

1. Open **Switch Console**.
2. Click **Your Agents** in the sidebar.
3. Delete Oggy's agent. Its key dies with it.
4. Do Step 2 again, but delete the `overwrite = $true` line.
5. Do Step 3.
6. Invite Oggy back into each room. This route removes it from all of them.

Sources: Switch docs on [registering an agent](https://docs.switchagents.ai/switch-rooms/internals/agent-protocol.md#register-the-agent), [registration keys](https://docs.switchagents.ai/switch-rooms/administer/people-and-agents.md) and [deleting an agent](https://docs.switchagents.ai/switch-rooms/getting-started/agent-settings.md#rename-or-move-the-agent).

---

## Build and release

From `frontend/`:

- `pnpm dist` builds `build/installer/Oggy-Setup.exe`. It bundles the backend, Node 22 and SQLite into the app first (`scripts/pack.mjs`). Run it with Node 22, after `pnpm install` in `backend/` and `frontend/`.
- `pnpm release` builds, then publishes `Oggy-Setup.exe` as a GitHub release named after `version` in `frontend/package.json` (`scripts/release.mjs`, which needs `gh auth login`). Bump the version before each release.
