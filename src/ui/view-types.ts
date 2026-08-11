// The view models the UI components render, as opposed to the wire shapes in ../types.ts and the
// store's own SessionRow. They live here rather than in types.ts because nothing outside src/ui
// (and the two fixture scripts that render these components) reads them.
//
// Same convention as ../types.ts: name only what the components actually read, and stay permissive
// where a caller can honestly hand over less. A roster row reaches these components from three
// places — the store's publicView, browse's raw opencode listing, and the fixture scripts — and
// only `id`/`projectKey`/`status` are guaranteed by all three, so the rest are optional. The index
// signature is what lets a richer row (SessionRow, a browse row carrying extra opencode fields)
// flow straight in without each caller having to strip itself down to this shape.

import type { PullRequest } from '../types.ts'

// A session as a roster row, a header count or a peek panel reads it.
export type RosterSession = {
  id: string
  projectKey: string
  status: string
  title?: string
  // The store publishes '' for "nothing to say"; browse rows may carry nothing at all.
  snippet?: string | null
  agent?: string
  // Which CLI is behind the row; absent means opencode (see Roster's showBackendTag).
  backend?: string
  prs?: PullRequest[]
  pinned?: boolean
  // Manual rank from ⇧↑/⇧↓ — App sorts on it, the row never draws it.
  rank?: number
  createdAt?: number
  updatedAt?: number
  // null is "this run has no meaningful duration", which is not the same as "unknown".
  ranForMs?: number | null
  waitingSince?: number
  pendingRequest?: boolean
  [key: string]: unknown
}

// A group of rows under one header — a project in browse/project grouping, a state in the default.
export type RosterGroup = {
  projectKey: string
  repoName: string
  sessions: RosterSession[]
  // An always-shown group draws a placeholder instead of collapsing away when it has no sessions.
  empty?: boolean
  hint?: string
  // How many sessions the caller trimmed off the end (the `… N more` line).
  hidden?: number
}

// What buildLines() emits and windowLines() slices: one entry per rendered row. A discriminated
// union, so the Roster's render branches and App's click-to-row mapping both narrow on `type`
// rather than reaching for fields that may not be there.
export type RosterLine =
  | { type: 'spacer'; key: string }
  | { type: 'header'; key: string; projectKey: string; collapsed: boolean; text: string }
  | { type: 'session'; key: string; session: RosterSession }
  | { type: 'placeholder'; key: string; text: string }
  | { type: 'hidden'; key: string; text: string }

// A membership test over row keys. Structural rather than `Set<string>` on purpose: every consumer
// only ever asks `has(key)`, and callers hand over anything set-shaped (App's `new Set(...)`, the
// fixture scripts' literal sets).
export type KeySet = { has(key: string): boolean }

// Everything the header's count and the tab title need off a row. Deliberately narrower than
// RosterSession: both are pure counts over statuses, and the tests exercise them with bare
// `{status, pendingRequest}` pairs rather than whole rows.
export type StatusCountable = {
  status: string
  pendingRequest?: boolean
  [key: string]: unknown
}

// A pending permission as peek banners it. Looser than the wire's PermissionAsked: the banner has
// an id-only fallback for a payload that arrived without a `permission`, and that fallback is
// tested with exactly such a payload.
export type PeekPermission = {
  id?: string
  permission?: string
  patterns?: string[]
  [key: string]: unknown
}

export type PeekQuestionOption = {
  label?: string
  description?: string
  [key: string]: unknown
}

export type PeekQuestionInfo = {
  question?: string
  header?: string
  options?: PeekQuestionOption[]
  [key: string]: unknown
}

// A pending question as peek renders it — the wire's QuestionAsked with every field optional,
// because peek must survive a payload that is missing any of them (it renders a label fallback
// chain and an empty option list rather than throwing inside an Ink render).
export type PeekQuestion = {
  id?: string
  sessionID?: string
  questions?: PeekQuestionInfo[]
  tool?: unknown
  [key: string]: unknown
}

// One rendered line of the peek body, before wrapping.
export type PeekRow = { text: string; dim?: boolean; color?: string }

// The model label the header prints. Both halves are optional: `dispatchModel` is whatever
// /model set, and an incomplete one prints what it has rather than hiding the line.
export type ModelRef = { providerID?: string; id?: string }

// A `@`/`/` completion candidate as the input lists it.
export type Suggestion = { name: string; kind: string }
export type SuggestionList = { sigil: string; matches: Suggestion[]; partial?: string }

// One row of the `?` overlay: a section heading, or a key/description pair. Both members carry both
// fields (one always undefined) so callers can read `line.heading ?? line.keys` without narrowing.
export type HelpLine = { heading: string; keys?: undefined; what?: undefined } | { heading?: undefined; keys: string; what: string }
