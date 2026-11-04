import { spawn } from 'node:child_process'

/**
 * Shipping is the release agent's job: it merges, pushes, and Render builds from the push. Oggy only
 * tells it when the team agreed, and afterwards looks for itself, so "live" is never just a claim.
 */

export interface DeployTarget {
  /** The branch that goes live. */
  branch: string
  /** Where to check it's up, like https://paytrack-api.onrender.com/health. */
  url?: string
}

/** The job for the release agent, once everyone said yes. */
export function shipJob(project: string, target: DeployTarget, voters: string[], named = false): string {
  return `${named ? `Approved by ${voters.join(' and ')}.` : `The whole team said yes (${voters.join(', ')}).`} Ship ${project}: merge the branch into ${target.branch} and push to origin.${liveCheck(target)} Start your last message with "🚀 We shipped ${project}" and say what went live.`
}

const liveCheck = (target: DeployTarget) =>
  target.url
    ? ` Then check ${target.url} until it reports the commit you pushed: Render builds from the push, which can take a few minutes. If that page has no commit in it, that isn't a failure: wait two minutes, make sure it answers, and say the version couldn't be confirmed.`
    : ''

/** The job for the release agent when production has to go back. A revert keeps the history; a force push never does. */
export function rollbackJob(project: string, target: DeployTarget): string {
  return `Roll ${project} back: find the deploy that broke it (the reports below say which) and undo it with git revert on ${target.branch}, then push to origin. Never force push, and never touch anything but that revert.${liveCheck(target)} Start your last message with "⏪ Rolled back ${project}" and say which commit you reverted.`
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    let out = ''
    const child = spawn('git', args, { cwd, windowsHide: true })
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => done(''))
    child.on('close', () => done(out.trim()))
  })
}

/**
 * Oggy's own look after the agent reports. 'proved': the site runs what's on GitHub. 'answering': it's
 * up but doesn't say which version. 'old': it says a different version. 'down': no answer.
 */
export async function seenLive(dir: string, target: DeployTarget): Promise<'proved' | 'answering' | 'old' | 'down' | undefined> {
  if (!target.url) return undefined
  const head = (await git(dir, ['ls-remote', 'origin', `refs/heads/${target.branch}`])).slice(0, 7)
  const site = await fetch(target.url, { signal: AbortSignal.timeout(20_000) })
    .then(async (r) => ({ up: r.ok, body: await r.text() }))
    .catch(() => ({ up: false, body: '' }))
  if (!site.up) return 'down'
  if (!/commit/i.test(site.body)) return 'answering'
  return head && site.body.includes(head) ? 'proved' : 'old'
}
