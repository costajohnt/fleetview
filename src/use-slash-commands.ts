import { withMember, type Roster } from './roster-store.ts'
import type { AppAction, AttachTarget, BackendCapabilities, ModelPair } from './types.ts'
import type { SeenMap } from './seen-store.ts'
import type { SessionStore } from './session-store.ts'
import type { RosterClient, ProviderInfo } from './backends/opencode/client.ts'
import type { RosterSession } from './ui/view-types.ts'

// The slash commands fleetview runs itself (`/exit`, `/quit`, `/fork`, `/model`) — the
// `view-command` branch of App's submit, lifted out the same way useDispatch was. Re-invoked per
// render, so the returned runner closes over that render's selection and provider list.
export function useSlashCommands({
  client,
  store,
  seen,
  hasOpencode,
  needsOpencode,
  current,
  capabilitiesOf,
  backendNameOf,
  providers,
  setDispatchModel,
  setInput,
  updateRoster,
  onAction,
  exit,
  flash,
}: {
  client: RosterClient
  store: SessionStore
  seen?: SeenMap
  hasOpencode: boolean
  needsOpencode: (what: string) => void
  current: RosterSession | undefined
  capabilitiesOf: (row: AttachTarget) => BackendCapabilities
  backendNameOf: (row: AttachTarget) => string
  providers: ProviderInfo[]
  setDispatchModel: (model: ModelPair | null) => void
  setInput: (value: string) => void
  updateRoster: (updater: (prev: Roster) => Roster) => void
  onAction: (action: AppAction) => unknown
  exit: () => void
  flash: (message: string, ms?: number) => void
}) {
  return (command: string | undefined, args: string | undefined) => {
    if (command === 'exit' || command === 'quit') {
      onAction({ type: 'quit' })
      return exit()
    }
    // "/fork copies the conversation to a new background session" — here it acts on the
    // selected row, and an argument becomes the fork's first new prompt.
    if (!hasOpencode) {
      setInput('')
      return needsOpencode(`/${command}`)
    }
    if (command === 'fork') {
      if (!current) return flash('select a session to fork')
      // Capability gate, driven only by the backend's own flags: claude has --fork-session but the
      // Backend contract has no fork(), and copilot has no fork at all — either way the honest
      // answer is to say so rather than call a client method that would hit the wrong server.
      if (!capabilitiesOf(current).fork) {
        setInput('')
        return flash(`${backendNameOf(current)} can't fork a session`, 4000)
      }
      const row = current
      ;(async () => {
        let forkedId: string | null = null
        let done = false
        try {
          const forked = await client.forkSession(row.id, row.projectKey)
          forkedId = forked.id
          updateRoster((prev) => withMember(prev, row.projectKey, forked.id, args ? { prompt: args.slice(0, 2000) } : {}))
          if (args) await client.promptAsync(forked.id, args, row.projectKey)
          done = true
          flash(`forked → ${forked.id.slice(0, 12)}${args ? ' (prompt sent)' : ''}`)
          store.setSessions(row.projectKey, await client.listSessions(row.projectKey), seen)
        } catch {
          // Only the refresh failed: the fork and its prompt landed, and the next poll relists.
          if (done) return
          // The fork exists once forkSession answered: "couldn't fork" would invite a retry that
          // makes a second one. Say which half failed.
          flash(forkedId ? `forked → ${forkedId.slice(0, 12)}, but the prompt was not sent` : "couldn't fork — server refused", 4000)
        }
      })()
      setInput('')
      return
    }
    // "/model followed by a model name ... sessions you dispatch afterwards use it."
    if (!args || args === 'default') {
      setDispatchModel(null)
      setInput('')
      return flash('dispatch model: server default')
    }
    const [providerID, ...rest] = args.split('/')
    const modelID = rest.join('/')
    // Leave the text alone so it can be corrected rather than retyped.
    if (!modelID) return flash('use /model <provider>/<model>, or /model default')
    const provider = providers.find((p) => p.id === providerID)
    // Only reject when the list actually loaded; an unreachable /config/providers must not stop
    // someone setting a model they know is fine.
    if (providers.length > 0 && !provider) return flash(`no such provider: ${providerID}`)
    if (provider && !Object.hasOwn(provider.models ?? {}, modelID)) {
      return flash(`${providerID} has no model ${modelID}`)
    }
    setDispatchModel({ providerID, id: modelID })
    setInput('')
    return flash(`dispatch model: ${args}`)
  }
}
