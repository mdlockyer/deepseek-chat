import type { BoardPost, PostAudience, SubagentsParams } from './types.js'

export const BOARD_HEADING = 'On the board since your last step'

export type BoardPostOutcome = { ok: true; post: BoardPost } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const formatPostLine = (post: BoardPost): string => {
  switch (post.kind) {
    case 'finding': {
      const from = post.author.kind === 'agent' ? post.author.runId : 'lead'
      return `- [untrusted finding from ${from}] ${post.text} (source: ${post.url})`
    }
    case 'question': {
      const from = post.author.kind === 'agent' ? post.author.runId : 'lead'
      return `- [untrusted question from ${from}] ${post.question} (assuming meanwhile: ${post.assumption})`
    }
    case 'direction': {
      const target = post.to.kind === 'all' ? 'all' : post.to.runId
      return `- [direction from lead to ${target}] ${post.text}`
    }
  }
}

export const formatBoardDigest = (posts: readonly BoardPost[]): string | null => {
  if (posts.length === 0) {
    return null
  }
  return `${BOARD_HEADING}\n${posts.map(formatPostLine).join('\n')}`
}

export type MessageBoard = {
  readonly posts: () => BoardPost[]
  readonly postFromChild: (runId: string, input: unknown) => BoardPostOutcome
  readonly postFromLead: (
    input: unknown,
    activeRunIds: ReadonlySet<string>,
    knownRunIds: ReadonlySet<string>
  ) => BoardPostOutcome
  readonly drainForAgent: (runId: string) => BoardPost[]
  readonly drainForLead: () => BoardPost[]
  readonly hasUnseenQuestionForLead: () => boolean
}

export const createMessageBoard = (
  initialPosts: readonly BoardPost[],
  params: Pick<SubagentsParams, 'maxPostsPerChild' | 'maxPostChars'>,
  onPost: (post: BoardPost) => void,
  newId: () => string = () => crypto.randomUUID()
): MessageBoard => {
  const posts: BoardPost[] = [...initialPosts]
  const childPostCounts = new Map<string, number>()
  for (const post of posts) {
    if (post.author.kind === 'agent') {
      childPostCounts.set(post.author.runId, (childPostCounts.get(post.author.runId) ?? 0) + 1)
    }
  }
  const cursors = new Map<string, number>()
  const LEAD_KEY = '__lead__'
  cursors.set(LEAD_KEY, posts.length)

  const postFromChild = (runId: string, input: unknown): BoardPostOutcome => {
    const count = childPostCounts.get(runId) ?? 0
    if (count >= params.maxPostsPerChild) {
      return {
        ok: false,
        error: `Post cap reached: each subagent may post at most ${params.maxPostsPerChild} times.`,
      }
    }
    if (!isRecord(input)) {
      return { ok: false, error: 'Invalid post input: expected an object.' }
    }
    const kind = input.kind
    if (kind === 'finding') {
      const text = trimString(input.text)
      const url = trimString(input.url)
      if (!text || !url) {
        return { ok: false, error: 'Invalid finding: both "text" and "url" are required.' }
      }
      if (text.length > params.maxPostChars) {
        return {
          ok: false,
          error: `Post too long: finding text is ${text.length} characters, above the ${params.maxPostChars}-character cap.`,
        }
      }
      const post: BoardPost = {
        kind: 'finding',
        id: newId(),
        author: { kind: 'agent', runId },
        text,
        url,
      }
      posts.push(post)
      childPostCounts.set(runId, count + 1)
      onPost(post)
      return { ok: true, post }
    }
    if (kind === 'question') {
      const question = trimString(input.question)
      const assumption = trimString(input.assumption)
      if (!question || !assumption) {
        return {
          ok: false,
          error: 'Invalid question: both "question" and "assumption" are required.',
        }
      }
      const totalLen = question.length + assumption.length
      if (totalLen > params.maxPostChars) {
        return {
          ok: false,
          error: `Post too long: question and assumption total ${totalLen} characters, above the ${params.maxPostChars}-character cap.`,
        }
      }
      const post: BoardPost = {
        kind: 'question',
        id: newId(),
        author: { kind: 'agent', runId },
        question,
        assumption,
      }
      posts.push(post)
      childPostCounts.set(runId, count + 1)
      onPost(post)
      return { ok: true, post }
    }
    return {
      ok: false,
      error: `Invalid post kind "${String(kind)}": subagents may only post "finding" or "question".`,
    }
  }

  const parseAudience = (raw: unknown): PostAudience | null => {
    if (!isRecord(raw)) {
      return null
    }
    if (raw.kind === 'all') {
      return { kind: 'all' }
    }
    if (raw.kind === 'agent' && typeof raw.runId === 'string' && raw.runId.trim()) {
      return { kind: 'agent', runId: raw.runId.trim() }
    }
    return null
  }

  const postFromLead = (
    input: unknown,
    activeRunIds: ReadonlySet<string>,
    knownRunIds: ReadonlySet<string>
  ): BoardPostOutcome => {
    if (!isRecord(input) || input.kind !== 'direction') {
      return {
        ok: false,
        error: 'Invalid post input: lead posts must have kind "direction", "to", and "text".',
      }
    }
    const to = parseAudience(input.to)
    if (!to) {
      return {
        ok: false,
        error:
          'Invalid direction recipient: expected {"kind":"all"} or {"kind":"agent","runId":"..."}.',
      }
    }
    const text = trimString(input.text)
    if (!text) {
      return { ok: false, error: 'Invalid direction: "text" must not be empty.' }
    }
    if (text.length > params.maxPostChars) {
      return {
        ok: false,
        error: `Post too long: direction text is ${text.length} characters, above the ${params.maxPostChars}-character cap.`,
      }
    }
    if (to.kind === 'agent') {
      if (!activeRunIds.has(to.runId)) {
        const reason = knownRunIds.has(to.runId)
          ? `Cannot send direction: subagent "${to.runId}" has already ended.`
          : `Cannot send direction: unknown subagent "${to.runId}".`
        return { ok: false, error: reason }
      }
    }
    const post: BoardPost = {
      kind: 'direction',
      id: newId(),
      author: { kind: 'lead' },
      to,
      text,
    }
    posts.push(post)
    onPost(post)
    return { ok: true, post }
  }

  const drainForAgent = (runId: string): BoardPost[] => {
    const start = cursors.get(runId) ?? 0
    if (start >= posts.length) {
      return []
    }
    const unseen: BoardPost[] = []
    for (let i = start; i < posts.length; i += 1) {
      const post = posts[i]
      if (post.author.kind === 'agent' && post.author.runId === runId) {
        continue
      }
      if (post.kind === 'direction' && post.to.kind === 'agent' && post.to.runId !== runId) {
        continue
      }
      unseen.push(post)
    }
    cursors.set(runId, posts.length)
    return unseen
  }

  const drainForLead = (): BoardPost[] => {
    const start = cursors.get(LEAD_KEY) ?? 0
    if (start >= posts.length) {
      return []
    }
    const unseen: BoardPost[] = []
    for (let i = start; i < posts.length; i += 1) {
      const post = posts[i]
      if (post.author.kind === 'lead') {
        continue
      }
      unseen.push(post)
    }
    cursors.set(LEAD_KEY, posts.length)
    return unseen
  }

  const hasUnseenQuestionForLead = (): boolean => {
    const start = cursors.get(LEAD_KEY) ?? 0
    for (let i = start; i < posts.length; i += 1) {
      if (posts[i]?.kind === 'question') {
        return true
      }
    }
    return false
  }

  return {
    posts: () => [...posts],
    postFromChild,
    postFromLead,
    drainForAgent,
    drainForLead,
    hasUnseenQuestionForLead,
  }
}
