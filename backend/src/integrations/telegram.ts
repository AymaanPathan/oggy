import { config } from '../config.js'
import { log } from '../events.js'
import type { Approval, IntegrationStatus } from '../shared/types.js'

export function telegramStatus(): IntegrationStatus {
  const configured = Boolean(config.telegram.botToken && config.telegram.ownerChatId)
  return {
    name: 'telegram',
    ready: false,
    detail: configured ? 'Configured; bot lands in phase 2' : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID (phase 2)'
  }
}


export async function requestApprovalOnPhone(approval: Approval): Promise<void> {
  log('info', `Approval needed: ${approval.action} (Telegram delivery is stubbed; approve in the desktop app)`)
}

/** PHASE 2: "Message me on Telegram when the build finishes." */
export async function notifyOwner(_text: string): Promise<void> {}
