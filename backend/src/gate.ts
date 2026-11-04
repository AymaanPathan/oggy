import { config } from './config.js'
import type { PlanStep, Run } from './shared/types.js'
import { isToolName, TOOLBOX } from './toolbox.js'

/**
 * The safety gate. Every step passes through here right before it runs, whichever lane planned it:
 *   1. Is it from you?   Room commands must come from owner.discordUsername.
 *   2. Is it allowed?    A toolbox tool, with args inside the allowed folders and apps.
 *   3. Is it risky?      Then it waits for your yes (voice, desktop or a "yes" in the room).
 */
export type Verdict = { allowed: false; reason: string } | { allowed: true; risky: boolean; preview: string }

/** Did you send this? Desktop and HTTP commands carry your owner token, so only room commands need checking. */
export function fromOwner(run: Pick<Run, 'source' | 'requestedBy'>): boolean {
  if (run.source !== 'switch' || !config.safety.onlyObeyOwner) return true
  // A room run keeps whatever was checked when it came in: the sender id, or (no id set) the name.
  return isOwner({ id: run.requestedBy, name: run.requestedBy })
}

/**
 * Is this room sender you? With owner.switchUserId set, only that exact Switch id counts: it pins the
 * app and the account (@switch-discord-<bridge>-aymaan2218:…), so a Mattermost user or an agent with
 * your name can't pass. Without it, your username (any app), as a fallback.
 */
export function isOwner(sender: { id?: string; name?: string } | undefined): boolean {
  const { switchUserId, username } = config.owner
  if (switchUserId) return Boolean(sender?.id) && sender!.id === switchUserId
  return Boolean(username && sender?.name && sender.name.trim().toLowerCase() === username.toLowerCase())
}

/** What a room run remembers as "who asked": the id when Oggy checks ids, else the name. */
export const requesterOf = (m: { sender: string; senderName: string }) => (config.owner.switchUserId ? m.sender : m.senderName || m.sender)

/** Risky in the toolbox, or listed in safety.needsApproval by tool name (file.delete) or last word (delete). */
function needsApproval(step: PlanStep): boolean {
  const tool = TOOLBOX[step.kind]
  const args = step.args ?? {}
  if (step.risky || (typeof tool.risky === 'function' ? tool.risky(args) : tool.risky)) return true
  const short = step.kind.split('.').pop()!
  return config.safety.needsApproval.some((n) => {
    const name = n.trim().toLowerCase()
    return name === step.kind || name === short
  })
}

export function gate(run: Run, step: PlanStep): Verdict {
  if (!fromOwner(run)) {
    return {
      allowed: false,
      reason: config.owner.username || config.owner.switchUserId
        ? `Only ${config.owner.username} can tell Oggy what to do (this came from ${run.requestedBy || 'someone else'}).`
        : 'Set owner.discordUsername in ~/.oggy/config.json so Oggy knows which room messages are yours.'
    }
  }
  if (!isToolName(step.kind)) return { allowed: false, reason: `${String(step.kind)} is not in the toolbox.` }

  const tool = TOOLBOX[step.kind]
  const args = step.args ?? {}
  let problem: string | undefined
  try {
    problem = tool.check?.(args)
  } catch (err) {
    problem = `Could not check this step: ${(err as Error).message}`
  }
  if (problem) return { allowed: false, reason: problem }

  return { allowed: true, risky: needsApproval(step), preview: tool.preview?.(args) || step.title }
}
