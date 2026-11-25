import type { ToolDefinition, ToolRunResult } from '@deepseek-chat/lib-tools'
import { create } from 'zustand'

export const ASK_USER_TOOL_NAME = 'ask_user'

export type AskUserOption = {
  readonly label: string
  readonly description?: string
  readonly recommended?: boolean
}

export type AskUserQuestion = {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options?: readonly AskUserOption[]
  readonly multiSelect: boolean
  readonly allowCustom: boolean
}

export type AskActionItem = {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly answer?: string | string[]
}

export type AskActionMeta = {
  readonly status: 'answered' | 'skipped'
  readonly items: AskActionItem[]
}

export type PendingAskUser = {
  readonly sessionId: string
  readonly questions: readonly AskUserQuestion[]
  readonly submit: (answers: Record<string, string | string[]>) => void
  readonly skip: () => void
  readonly abort: () => void
}

export const ASK_USER_TOOL: ToolDefinition = {
  name: ASK_USER_TOOL_NAME,
  description:
    'Ask the user 1–4 short, structured clarifying questions in a compact card docked above the chat input, and wait for their selection or custom answer before continuing.',
  input_schema: {
    type: 'object',
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '1 to 4 concise clarifying questions to present to the user.',
        items: {
          type: 'object',
          required: ['id', 'header', 'question'],
          properties: {
            id: {
              type: 'string',
              description: 'Short unique snake_case identifier for this question (e.g. "theme").',
            },
            header: {
              type: 'string',
              description: 'Short 1–3 word pill/tab label (e.g. "Theme", "Audience").',
            },
            question: {
              type: 'string',
              description: 'Clear 1-sentence question shown to the user.',
            },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              description:
                '2 to 4 concrete choices. Put your recommended choice first and mark recommended: true. Omit for a short free-text question.',
              items: {
                type: 'object',
                required: ['label'],
                properties: {
                  label: { type: 'string', description: 'Short option label (1–5 words).' },
                  description: {
                    type: 'string',
                    description: 'Optional 1-line explanation of this choice or trade-off.',
                  },
                  recommended: {
                    type: 'boolean',
                    description: 'Set true on your recommended default option.',
                  },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Allow choosing multiple options (default false).',
            },
            allow_custom: {
              type: 'boolean',
              description: 'Include an inline "Other…" custom input escape hatch (default true).',
            },
          },
        },
      },
    },
  },
}

export const ASK_USER_INSTRUCTIONS = [
  'Clarifying Questions (`ask_user`):',
  'When a request has a real fork in direction where guessing wrong would waste significant work, or is missing a required target, constraint, or preference, call `ask_user` instead of writing a wall of numbered questions in prose. The app docks a compact clickable card above the chat input (with keyboard shortcuts and an automatic "Other…" escape hatch) and returns the user’s structured answers right back into this turn.',
  'Use `ask_user` sparingly: never interrogate the user before straightforward tasks or over minor defaults you can pick sensibly and mention. Keep it to 1–4 short, plain-spoken questions with concrete trade-offs, put your recommended choice first with `recommended: true`, and if the user clicks Skip, proceed cleanly using your best judgment.',
].join('\n')

export type ParseAskUserResult =
  | { readonly ok: true; readonly questions: AskUserQuestion[] }
  | { readonly ok: false; readonly error: string }

export const parseAskUserInput = (raw: unknown): ParseAskUserResult => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid input: expected {"questions": [...]}.' }
  }
  const list = (raw as { questions?: unknown }).questions
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array of 1 to 4 question objects.' }
  }
  const seenIds = new Set<string>()
  const questions: AskUserQuestion[] = []
  for (let i = 0; i < Math.min(list.length, 4); i++) {
    const entry = list[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `Question #${i + 1} must be an object.` }
    }
    const rec = entry as Record<string, unknown>
    const question = typeof rec.question === 'string' ? rec.question.trim() : ''
    if (!question) {
      return { ok: false, error: `Question #${i + 1} requires a non-empty "question" string.` }
    }
    const rawId = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `q${i + 1}`
    const id = seenIds.has(rawId) ? `${rawId}_${i + 1}` : rawId
    seenIds.add(id)
    const header =
      typeof rec.header === 'string' && rec.header.trim() ? rec.header.trim() : id.slice(0, 20)

    let options: AskUserOption[] | undefined
    if (Array.isArray(rec.options) && rec.options.length > 0) {
      const parsed: AskUserOption[] = []
      for (const opt of rec.options.slice(0, 4)) {
        if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
          continue
        }
        const optRec = opt as Record<string, unknown>
        const label = typeof optRec.label === 'string' ? optRec.label.trim() : ''
        if (!label) {
          continue
        }
        const description =
          typeof optRec.description === 'string' && optRec.description.trim()
            ? optRec.description.trim()
            : undefined
        parsed.push({
          label,
          ...(description ? { description } : {}),
          ...(optRec.recommended === true ? { recommended: true } : {}),
        })
      }
      if (parsed.length > 0) {
        options = parsed
      }
    }

    questions.push({
      id,
      header,
      question,
      ...(options ? { options } : {}),
      multiSelect: rec.multi_select === true && Boolean(options?.length),
      allowCustom: rec.allow_custom !== false || !options?.length,
    })
  }
  return { ok: true, questions }
}

type AskUserStoreState = {
  pendingBySession: Record<string, PendingAskUser | undefined>
}

export const createAskUserState = () => {
  const useStore = create<AskUserStoreState>(() => ({
    pendingBySession: {},
  }))

  const setPending = (sessionId: string, pending: PendingAskUser | undefined) =>
    useStore.setState((state) => {
      if (pending === undefined) {
        if (!Object.hasOwn(state.pendingBySession, sessionId)) {
          return state
        }
        const next = Object.fromEntries(
          Object.entries(state.pendingBySession).filter(([key]) => key !== sessionId)
        )
        return { pendingBySession: next }
      }
      return { pendingBySession: { ...state.pendingBySession, [sessionId]: pending } }
    })

  const submit = (sessionId: string, answers: Record<string, string | string[]>): boolean => {
    const pending = useStore.getState().pendingBySession[sessionId]
    if (!pending) {
      return false
    }
    pending.submit(answers)
    return true
  }

  const skip = (sessionId: string): boolean => {
    const pending = useStore.getState().pendingBySession[sessionId]
    if (!pending) {
      return false
    }
    pending.skip()
    return true
  }

  const cancelSession = (sessionId: string) => {
    const pending = useStore.getState().pendingBySession[sessionId]
    pending?.abort()
  }

  const cancelAll = () => {
    const all = Object.values(useStore.getState().pendingBySession)
    for (const pending of all) {
      pending?.abort()
    }
  }

  const run = (
    rawInput: unknown,
    options: { readonly sessionId: string; readonly signal: AbortSignal }
  ): Promise<ToolRunResult & { readonly askAction?: AskActionMeta }> => {
    const startedAt = Date.now()
    if (options.signal.aborted) {
      return Promise.resolve({
        status: 'aborted',
        content: 'Aborted by user.',
        durationMs: 0,
      })
    }
    const parsed = parseAskUserInput(rawInput)
    if (!parsed.ok) {
      return Promise.resolve({
        status: 'error',
        content: parsed.error,
        durationMs: Date.now() - startedAt,
      })
    }
    const { questions } = parsed
    const { sessionId, signal } = options

    return new Promise((resolve) => {
      let settled = false
      const finish = (result: ToolRunResult & { readonly askAction?: AskActionMeta }) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (useStore.getState().pendingBySession[sessionId] === pending) {
          setPending(sessionId, undefined)
        }
        resolve({ ...result, durationMs: Date.now() - startedAt })
      }

      const onAbort = () => {
        finish({ status: 'aborted', content: 'Aborted by user.' })
      }

      const pending: PendingAskUser = {
        sessionId,
        questions,
        abort: onAbort,
        submit: (rawAnswers) => {
          const answers: Record<string, string | string[]> = {}
          const items: AskActionItem[] = questions.map((q) => {
            const rawValue = rawAnswers[q.id]
            if (Array.isArray(rawValue)) {
              const cleaned = rawValue.map((v) => v.trim()).filter(Boolean)
              if (cleaned.length > 0) {
                answers[q.id] = cleaned
                return { id: q.id, header: q.header, question: q.question, answer: cleaned }
              }
            } else if (typeof rawValue === 'string' && rawValue.trim()) {
              const cleaned = rawValue.trim()
              answers[q.id] = cleaned
              return { id: q.id, header: q.header, question: q.question, answer: cleaned }
            }
            return { id: q.id, header: q.header, question: q.question }
          })
          const askAction: AskActionMeta = { status: 'answered', items }
          finish({
            status: 'ok',
            content: JSON.stringify({ status: 'answered', answers }),
            askAction,
            payload: askAction,
            frontStageNote: {
              status: 'done',
              items: items.map((item) => ({
                id: item.id,
                label: item.header,
                question: item.question,
                ...(item.answer !== undefined ? { value: item.answer } : {}),
              })),
            },
          })
        },
        skip: () => {
          const items = questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
          }))
          const askAction: AskActionMeta = { status: 'skipped', items }
          finish({
            status: 'ok',
            content: JSON.stringify({
              status: 'skipped',
              note: 'User skipped the questions and asked you to proceed using your best judgment.',
            }),
            askAction,
            payload: askAction,
            frontStageNote: {
              status: 'skipped',
              items: items.map((item) => ({
                id: item.id,
                label: item.header,
                question: item.question,
              })),
            },
          })
        },
      }

      signal.addEventListener('abort', onAbort, { once: true })
      setPending(sessionId, pending)
    })
  }

  return {
    useStore,
    submit,
    skip,
    cancelSession,
    cancelAll,
    run,
  }
}

export type AskUserState = ReturnType<typeof createAskUserState>
