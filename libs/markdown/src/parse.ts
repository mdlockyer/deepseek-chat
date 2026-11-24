import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import type { CitationSource } from './context.js'
import { createCurrencySafeMathExtension } from './mathText.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: CitationSource
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
const MATH_EXTENSION = createCurrencySafeMathExtension()
const CITATION_RUN = /([ \t]*)((?:\[(?:citation|ref):\d+\][ \t]*)+)/g
const CITATION_TOKEN = /\[(?:citation|ref):(\d+)\]/g
const PUNCTUATION_AFTER = /^[.,;:!?)\]}，。；：！？）》】]/

export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: readonly CitationSource[] | undefined; disableLink: boolean }
): Root {
  const ast = fromMarkdown(input, {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      MATH_EXTENSION,
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        CITATION_RUN,
        (
          full: string,
          leadingSpace: string,
          run: string,
          match: { index: number; input: string }
        ): CitationNode | Text | Array<Text | CitationNode> | '' => {
          const matched: CitationNode[] = []
          for (const token of run.matchAll(CITATION_TOKEN)) {
            const source = sourcesByIndex.get(Number(token[1]))
            if (source) {
              matched.push({ type: 'citation', source })
            }
          }
          const hasTrailingSpace = /[ \t]$/.test(run)
          const after = match.input.slice(match.index + full.length)
          const beforeStop = after.length === 0 || PUNCTUATION_AFTER.test(after)
          if (matched.length > 0) {
            const nodes: Array<Text | CitationNode> = []
            if (leadingSpace) {
              nodes.push(text(leadingSpace))
            }
            nodes.push(...matched)
            if (hasTrailingSpace && !beforeStop) {
              nodes.push(text(' '))
            }
            return nodes.length === 1 ? nodes[0] : nodes
          }
          if (beforeStop) {
            return ''
          }
          if (leadingSpace || hasTrailingSpace) {
            return text(' ')
          }
          return ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}
