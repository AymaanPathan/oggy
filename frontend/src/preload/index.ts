import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC, type OggyApi } from '@common/api'
import type { OggyEvent } from '@shared/types'

const api: OggyApi = {
  submitCommand: (text) => ipcRenderer.invoke(IPC.submit, text),
  listRuns: () => ipcRenderer.invoke(IPC.runs),
  listApprovals: () => ipcRenderer.invoke(IPC.approvals),
  decideApproval: (id, approve) => ipcRenderer.invoke(IPC.decide, id, approve),
  listWorkflows: () => ipcRenderer.invoke(IPC.workflows),
  deleteWorkflow: (id) => ipcRenderer.invoke(IPC.deleteWorkflow, id),
  listMemory: () => ipcRenderer.invoke(IPC.memory),
  integrations: () => ipcRenderer.invoke(IPC.integrations),
  hideCommandBar: () => ipcRenderer.send(IPC.hideBar),
  peekCommandBar: () => ipcRenderer.send(IPC.peekBar),
  setBarPinned: (pinned) => ipcRenderer.send(IPC.pinBar, pinned),
  setBarInteractive: (interactive) => ipcRenderer.send(IPC.barInteractive, interactive),
  onBarVisible(cb) {
    const h = (_: IpcRendererEvent, visible: boolean, focused: boolean) => cb(visible, focused)
    ipcRenderer.on(IPC.barVisible, h)
    return () => ipcRenderer.off(IPC.barVisible, h)
  },
  onEvent(cb) {
    const h = (_: IpcRendererEvent, e: OggyEvent) => cb(e)
    ipcRenderer.on(IPC.event, h)
    return () => ipcRenderer.off(IPC.event, h)
  },
  onBackendStatus(cb) {
    const h = (_: IpcRendererEvent, online: boolean) => cb(online)
    ipcRenderer.on(IPC.backendStatus, h)
    void ipcRenderer.invoke(IPC.backendStatus).then(cb)
    return () => ipcRenderer.off(IPC.backendStatus, h)
  },
  onShow(cb) {
    const h = (_: IpcRendererEvent, effect: Parameters<typeof cb>[0]) => cb(effect)
    ipcRenderer.on(IPC.show, h)
    return () => ipcRenderer.off(IPC.show, h)
  },
  setShowInteractive: (interactive) => ipcRenderer.send(IPC.showInteractive, interactive),
  showIdle: () => ipcRenderer.send(IPC.showIdle),
  openShot: (path, reveal = false) => ipcRenderer.send(IPC.openShot, path, reveal),
  openChange: (runId, path) => ipcRenderer.invoke(IPC.openChange, runId, path),
  decideReview: (runId, text, ask = false) => ipcRenderer.invoke(IPC.decideReview, runId, text, ask),
  setReviewOpen: (open, focus = true) => ipcRenderer.send(IPC.reviewOpen, open, focus),
  onCloseRequested(cb) {
    const h = () => cb()
    ipcRenderer.on(IPC.closeRequested, h)
    return () => ipcRenderer.off(IPC.closeRequested, h)
  },
  quit: () => ipcRenderer.send(IPC.quit),
  minimizeWindow: () => ipcRenderer.send(IPC.minimizeWindow),
  getTeam: () => ipcRenderer.invoke(IPC.team),
  runDetail: (runId) => ipcRenderer.invoke(IPC.runDetail, runId)
}

contextBridge.exposeInMainWorld('oggy', api)
