import { config } from './config.js'
import { memory } from './db.js'
import { isOwner } from './gate.js'
import type { TeamVote } from './shared/types.js'

/**
 * The people on the team, and their votes. Agents do the work; anything that can't be taken back
 * (a deploy) waits until every person has said yes, and one no stops it.
 */

export interface Person {
  name: string
  /** Their username on the chat app, which is how Switch names them in rooms. */
  username: string
  /** Their exact Switch id, when known: the only thing that counts then. */
  switchUserId: string
}

/** You first, then everyone in config.team. */
export function people(): Person[] {
  const you: Person = { name: config.owner.name, username: config.owner.username, switchUserId: config.owner.switchUserId }
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  return [you, ...config.team.filter((p) => !same(p.name, you.name) && !(p.username && same(p.username, you.username)))]
}

/** Who this room sender is. An id on file has to match exactly, so a lookalike name counts for nothing. */
export function personOf(sender: { id?: string; name?: string }): Person | undefined {
  return people().find((p, i) => {
    if (i === 0) return isOwner(sender)
    if (p.switchUserId) return sender.id === p.switchUserId
    return Boolean(p.username && sender.name && sender.name.trim().toLowerCase() === p.username.toLowerCase())
  })
}

const key = (approvalId: string) => `vote.${approvalId}`

export function voteOf(approvalId: string): TeamVote | undefined {
  try {
    return (JSON.parse(memory.get(key(approvalId)) || 'null') as TeamVote | null) ?? undefined
  } catch {
    return undefined
  }
}

/** Everyone on the team, or just the people a workflow named. */
export function openVote(approvalId: string, named?: string[]): TeamVote {
  const everyone = people().map((p) => p.name)
  const voters = named ?? everyone
  const vote: TeamVote = { voters, answers: {}, ...(voters.includes(everyone[0]) ? {} : { notYou: true }) }
  memory.set(key(approvalId), JSON.stringify(vote))
  return vote
}

/** Everyone said yes, someone said no, or it's still open. */
export const outcome = (v: TeamVote): 'approved' | 'rejected' | undefined =>
  Object.values(v.answers).includes('no') ? 'rejected' : v.voters.every((n) => v.answers[n] === 'yes') ? 'approved' : undefined

/** A person's answer. They can change it until the vote closes. Only people on the vote count. */
export function castVote(approvalId: string, voter: string, yes: boolean): TeamVote | undefined {
  const vote = voteOf(approvalId)
  if (!vote || !vote.voters.includes(voter)) return undefined
  vote.answers[voter] = yes ? 'yes' : 'no'
  memory.set(key(approvalId), JSON.stringify(vote))
  return vote
}
