import type { AgentSourceSpec, CitedSourceMeta } from '@deepseek-chat/lib-tools'

const getSiteName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

export type NumberedChildResult = {
  /** Child's answer with `[n]` markers rewritten to `[ref:M]`, followed by a source ledger. */
  readonly content: string
  /** Deduplicated sources in assigned order. */
  readonly sources: CitedSourceMeta[]
  /** Updated citation map including any newly numbered URLs. */
  readonly citedUrls: Map<string, number>
}

/**
 * Assigns reply-wide citation numbers to a child's sources, continuing from `existingCitedUrls`
 * without gaps, and rewrites the child's `[n]` citations to `[ref:M]`.
 */
export const assignChildCitations = (
  content: string,
  sources: readonly AgentSourceSpec[],
  existingCitedUrls: ReadonlyMap<string, number>
): NumberedChildResult => {
  const citedUrls = new Map(existingCitedUrls)
  const localToGlobal = new Map<number, number>()
  const numberedSources: Array<{ globalN: number; source: AgentSourceSpec }> = []
  const ledgerByGlobalN = new Map<number, number>()
  const outSources: CitedSourceMeta[] = []
  const addedUrls = new Set<string>()

  for (const source of sources) {
    const url = source.url.trim()
    if (!url) {
      continue
    }
    let globalN = citedUrls.get(url)
    if (globalN === undefined) {
      globalN = citedUrls.size + 1
      citedUrls.set(url, globalN)
    }
    localToGlobal.set(source.n, globalN)
    const existingIdx = ledgerByGlobalN.get(globalN)
    if (existingIdx === undefined) {
      ledgerByGlobalN.set(globalN, numberedSources.length)
      numberedSources.push({ globalN, source })
    } else if (
      source.verification === 'verified' &&
      numberedSources[existingIdx]?.source.verification !== 'verified'
    ) {
      numberedSources[existingIdx] = { globalN, source }
    }
    if (!addedUrls.has(url)) {
      addedUrls.add(url)
      outSources.push({
        url,
        title: source.title.trim() || url,
        snippet: '',
        siteName: getSiteName(url),
        publishedAt: null,
      })
    }
  }

  const rewritten =
    localToGlobal.size > 0
      ? content.replace(/\[(?:(?:citation|ref):)?(\d+)\](?!\()/g, (match, rawNum: string) => {
          const mapped = localToGlobal.get(Number(rawNum))
          return mapped !== undefined ? `[ref:${mapped}]` : match
        })
      : content

  if (numberedSources.length === 0) {
    return { content: rewritten, sources: outSources, citedUrls }
  }

  const ledger = numberedSources
    .map(
      ({ globalN, source }) =>
        `[ref:${globalN}] ${source.title.trim() || source.url} — ${source.url} (${source.verification})`
    )
    .join('\n')

  return {
    content: `${rewritten}\n\nSources:\n${ledger}`,
    sources: outSources,
    citedUrls,
  }
}
