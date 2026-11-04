import { spawnSync } from 'node:child_process'
import { config } from '../config.js'
import type { IntegrationStatus } from '../shared/types.js'

export interface CodexResult {
  stubbed: boolean
  ok: boolean
  output: string
}

export function codexStatus(): IntegrationStatus {
  const r = spawnSync(config.codexBin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const ready = r.status === 0
  return {
    name: 'codex',
    ready,
    detail: ready ? `CLI found (${r.stdout.trim()}); delegation lands in phase 2` : 'Codex CLI not found on PATH'
  }
}

/**
 * Delegate a coding task to Codex.
 * PHASE 2: post the task into the Switch room and/or run `codex exec` in `cwd`,
 * stream progress back as events, return Codex's final message.
 */
export async function delegateToCodex(prompt: string, cwd: string): Promise<CodexResult> {
  return {
    stubbed: true,
    ok: false,
    output: `Not sent yet: Codex delegation is stubbed in phase 1.\nWould ask Codex in ${cwd}:\n“${prompt}”`
  }
}
