import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
  ToolResultBlockParam,
} from './api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {}, inputJson: '' }
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        return next
      }
      blockIndexes.set(event.index, next.blocks.length)
      // 含客户端工具往返的回复不作为续写前缀。
      return {
        ...next,
        ...(block.type === 'tool_use' ? { prefix: false } : {}),
        blocks: [...next.blocks, block],
      }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
          return { ...block, inputJson: (block.inputJson ?? '') + delta.partial_json }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) => {
        if (block.type === 'tool_use') {
          const { inputJson, ...rest } = block
          if (!inputJson?.trim()) {
            return rest
          }
          try {
            return { ...rest, input: JSON.parse(inputJson) as unknown }
          } catch {
            // 解析失败时保留原文，执行时作为错误回传给模型。
            return block
          }
        }
        return block.type === 'thinking' &&
          block.startedAt !== undefined &&
          block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      })
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
/** 最后一个工具调用或结果块的位置 */
const lastToolIndex = (reply: AssistantMessage) =>
  reply.blocks.findLastIndex((block) => block.type === 'tool_use' || block.type === 'tool_result')

/**
 * 工具往返中断后可以接着进行：
 * - 报错或停止的回复，只要含工具调用；
 * - 正常结束但还有没执行的调用（服务端以非 tool_use 的原因结束、或旧版本留下的数据）。
 * 续接时先执行没有结果的调用，再从最后一个工具块之后请求。
 */
export const canResumeToolLoop = (reply: AssistantMessage): boolean => {
  if (
    lastToolIndex(reply) === -1 ||
    reply.stopReason === 'refusal' ||
    reply.error?.kind === 'upload'
  ) {
    return false
  }
  if (reply.status === 'error' || reply.status === 'stopped') {
    return true
  }
  if (reply.status !== 'done') {
    return false
  }
  const answered = new Set(
    reply.blocks.flatMap((block) =>
      block.type === 'tool_result' && block.status !== 'running' ? [block.tool_use_id] : []
    )
  )
  return reply.blocks.some((block) => block.type === 'tool_use' && !answered.has(block.id))
}

/**
 * 续接工具往返前：去掉最后一个工具块之后的半截内容，以及仍标记为运行中的结果（会重新执行）。
 */
export const trimAfterLastToolResult = (reply: AssistantMessage): AssistantMessage => {
  const last = lastToolIndex(reply)
  if (last === -1) {
    return reply
  }
  return {
    ...reply,
    blocks: reply.blocks
      .slice(0, last + 1)
      .filter((block) => block.type !== 'tool_result' || block.status !== 'running'),
  }
}

export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (canResumeToolLoop(reply)) {
    return true
  }
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        block.type === 'tool_use' ||
        block.type === 'tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' || (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = ({ content, files }: UserMessage): MessageParam => {
  const blocks = toFileBlocks(files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/**
 * assistant 的内容块按历史与续写场景转换为一条或多条消息：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 *   含客户端工具往返的回复保留全部思考块（服务端要求工具轮次回传思考）；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 服务端工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾；
 * - 客户端工具（python）：有结果的调用回传 tool_use，结果另起一条 user 消息（tool_result），
 *   之后的内容再起一条 assistant 消息；没有结果的调用不回传。
 */
/** 一次请求最多附带的工具图片张数，新结果优先；超出的只回传说明文字 */
const IMAGE_BUDGET_COUNT = 12

type ToolResult = Extract<ReplyBlock, { type: 'tool_result' }>

/** 从最新的工具结果往前挑选，张数在预算内的结果整体附带图片 */
export const pickImageResults = (blocks: ReplyBlock[]): ToolResult[] => {
  const picked: ToolResult[] = []
  let count = 0
  for (const block of [...blocks].reverse()) {
    if (block.type !== 'tool_result' || !block.images?.length) {
      continue
    }
    if (count + block.images.length > IMAGE_BUDGET_COUNT) {
      break
    }
    count += block.images.length
    picked.push(block)
  }
  return picked
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/** 工具结果的文字：附带图片时说明图片在结果之后，不附带时提示重新 show() */
const toToolResultText = (block: ToolResult, attached: number): string => {
  const count = block.images?.length ?? 0
  if (count === 0) {
    return block.content
  }
  if (attached === 0) {
    return `${block.content}\n[The ${count} ${plural(count, 'image is', 'images are')} no longer attached; re-run show() or browser_observe with screenshot=true to see ${plural(count, 'it', 'them')}.]`
  }
  const failed = count - attached
  return `${block.content}\n[${attached} ${plural(attached, 'image', 'images')} from this call ${plural(attached, 'follows', 'follow')} the tool results${failed ? `; ${failed} could not be uploaded` : ''}.]`
}

/** 已上传图片的 file_id 引用；带一行说明对应哪次调用 */
const toImageBlocks = (block: ToolResult): (TextBlockParam | FileBlockParam)[] => {
  const ids = (block.imageFileIds ?? []).filter((id): id is string => !!id)
  return ids.length === 0
    ? []
    : [
        { type: 'text', text: `Images from tool call ${block.tool_use_id}:` },
        ...ids.map(
          (id): FileBlockParam => ({ type: 'image', source: { type: 'file', file_id: id } })
        ),
      ]
}

const toAssistantMessages = (
  { blocks }: AssistantMessage,
  prefix = false,
  thinking = false,
  /** 是否附带工具结果中的图片：只有正在进行的回复附带，历史回复只回传文字 */
  includeImages = false,
  /** 本次请求声明的客户端工具；未声明的工具调用与结果不回传，只保留文字 */
  clientTools: boolean | ReadonlySet<string> = true
): MessageParam[] => {
  const imageResults = new Set(includeImages ? pickImageResults(blocks) : [])
  const isDeclaredTool = (name: string) =>
    typeof clientTools === 'boolean' ? clientTools : clientTools.has(name)
  const declaredToolIds = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool_use' && isDeclaredTool(block.name) ? [block.id] : []
    )
  )
  const hasClientTools = declaredToolIds.size > 0
  const answered = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool_result' &&
      block.status !== 'running' &&
      declaredToolIds.has(block.tool_use_id)
        ? [block.tool_use_id]
        : []
    )
  )
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  const messages: MessageParam[] = []
  let content: AssistantBlockParam[] = []
  let results: ToolResultBlockParam[] = []
  /** 结果之后的图片：同一条 user 消息里排在全部 tool_result 之后 */
  let images: (TextBlockParam | FileBlockParam)[] = []
  const pushResults = () => {
    messages.push({ role: 'user', content: [...results, ...images] })
    results = []
    images = []
  }
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  const pushAssistant = () => {
    const filtered = content.filter((block) => block.type !== 'text' || block.text !== '')
    if (filtered.length > 0) {
      messages.push({ role: 'assistant', content: filtered })
    }
    content = []
  }
  for (const block of blocks) {
    if (block.type === 'tool_use' && !isDeclaredTool(block.name)) {
      continue
    }
    if (block.type === 'tool_result') {
      if (!declaredToolIds.has(block.tool_use_id)) {
        continue
      }
      text = null
      if (answered.has(block.tool_use_id)) {
        const attached = imageResults.has(block) ? toImageBlocks(block) : []
        results.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: toToolResultText(block, attached.filter((item) => item.type === 'image').length),
        })
        images.push(...attached)
      }
      continue
    }
    if (results.length > 0) {
      pushAssistant()
      pushResults()
    }
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (block.type === 'thinking' && ((prefix && thinking) || hasClientTools)) {
      if (block.thinking.trim() || block.signature) {
        const { type, thinking, signature } = block
        content.push({ type, thinking, signature: signature ?? '' })
      }
    } else if (block.type === 'tool_use') {
      if (answered.has(block.id)) {
        const { type, id, name, input } = block
        content.push({ type, id, name, input })
      }
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    }
  }
  pushAssistant()
  if (results.length > 0) {
    pushResults()
  }
  return messages
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  /** 工具往返中的本轮回复：其调用与结果接在本轮提问之后，请求以 tool_result 结尾 */
  inProgress?: AssistantMessage,
  /** 本次请求声明的客户端工具，见 store.ts 的 declaredTools */
  clientTools: boolean | ReadonlySet<string> = true
): MessageParam[] => {
  const messages: MessageParam[] = []
  /** 被中止的工具往返以 user(tool_result) 结尾时，与下一条 user 合并，避免连续两条 user */
  const pushUser = (param: Extract<MessageParam, { role: 'user' }>) => {
    const last = messages.at(-1)
    if (last?.role === 'user' && Array.isArray(last.content)) {
      const extra =
        typeof param.content === 'string'
          ? [{ type: 'text' as const, text: param.content }]
          : param.content
      last.content = [...last.content, ...extra]
    } else {
      messages.push(param)
    }
  }
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      previousReminder = reminder
    }
  }
  for (const [user, reply] of getContextRounds(history)) {
    // 历史提问没有文字、附件也都没有 serverId 时，提问为空，连同回答一起省略。
    if (!user.content && toFileBlocks(user.files).length === 0) {
      continue
    }
    appendReminder(reply.latestReminder)
    pushUser(toUserParam(user) as Extract<MessageParam, { role: 'user' }>)
    messages.push(...toAssistantMessages(reply, false, false, false, clientTools))
  }
  appendReminder(latestReminder)
  pushUser(toUserParam(question) as Extract<MessageParam, { role: 'user' }>)
  if (inProgress) {
    messages.push(...toAssistantMessages(inProgress, false, false, true))
    return messages
  }
  if (prefix?.prefix) {
    const [assistant] = toAssistantMessages(prefix, true, thinking, false, clientTools)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant?.role === 'assistant' &&
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
