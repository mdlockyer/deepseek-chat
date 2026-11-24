import { math } from 'micromark-extension-llm-math'

type MathExtension = ReturnType<typeof math>
type TextMap = NonNullable<MathExtension['text']>
type TextEntry = NonNullable<TextMap[keyof TextMap]>
type FlatEntry = TextEntry extends ReadonlyArray<infer Item> ? Item : TextEntry
type TextConstruct = Extract<FlatEntry, { tokenize: unknown }>
type Tokenizer = TextConstruct['tokenize']
type State = ReturnType<Tokenizer>

const DOLLAR = 36
const SPACE = 32
const TAB = 9
const BACKSLASH = 92

const isLineEnding = (code: number | null) => code === -5 || code === -4 || code === -3
const isWhitespace = (code: number | null) =>
  code === SPACE || code === TAB || code === -2 || code === -1 || isLineEnding(code)
const isAsciiDigit = (code: number | null) => code !== null && code >= 48 && code <= 57

/**
 * Wraps `micromark-extension-llm-math` so single-dollar inline math obeys Pandoc/GitHub
 * currency-safe boundaries while `$$...$$`, `\(...\)`, and `\[...\]` remain unchanged:
 * - Opening single `$` cannot be followed by whitespace or EOF.
 * - Closing single `$` cannot be preceded by whitespace or followed by an ASCII digit (`0-9`).
 * - Escaped `\$` inside single-dollar math stays literal data instead of closing early.
 * - If a single `$` hits an invalid closer (like `$83 ... $70` or `$500 ... $O(n^2)$`),
 *   backtrack (`nok`) so the opening `$` stays plain currency text and later math still parses.
 */
export const createCurrencySafeMathExtension = (): MathExtension => {
  const base = math({ singleDollarTextMath: true })
  const baseTextEntry = base.text?.[DOLLAR]
  const baseConstruct = (
    Array.isArray(baseTextEntry) ? baseTextEntry[0] : baseTextEntry
  ) as TextConstruct

  const tokenize: Tokenizer = function tokenizeCurrencySafeMathText(effects, ok, nok) {
    let sizeOpen = 0
    let size = 0
    let prevCode: number | null = null
    let backslashes = 0
    let token: ReturnType<typeof effects.enter> | undefined

    const start: State = (code) => {
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      return sequenceOpen(code)
    }

    const sequenceOpen: State = (code) => {
      if (code === DOLLAR) {
        effects.consume(code)
        sizeOpen += 1
        return sequenceOpen
      }
      effects.exit('mathTextSequence')
      if (sizeOpen === 1 && (code === null || isWhitespace(code))) {
        return nok(code)
      }
      prevCode = null
      backslashes = 0
      return between(code)
    }

    const between: State = (code) => {
      if (code === null) {
        return nok(code)
      }
      if (code === DOLLAR) {
        if (sizeOpen === 1 && backslashes % 2 === 1) {
          effects.enter('mathTextData')
          effects.consume(code)
          prevCode = DOLLAR
          backslashes = 0
          return data
        }
        token = effects.enter('mathTextSequence')
        size = 0
        return sequenceClose(code)
      }
      if (code === SPACE) {
        prevCode = SPACE
        backslashes = 0
        effects.enter('space')
        effects.consume(code)
        effects.exit('space')
        return between
      }
      if (isLineEnding(code)) {
        prevCode = code
        backslashes = 0
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return between
      }
      effects.enter('mathTextData')
      return data(code)
    }

    const data: State = (code) => {
      if (code === DOLLAR && sizeOpen === 1 && backslashes % 2 === 1) {
        effects.consume(code)
        prevCode = DOLLAR
        backslashes = 0
        return data
      }
      if (code === null || code === SPACE || code === DOLLAR || isLineEnding(code)) {
        effects.exit('mathTextData')
        return between(code)
      }
      backslashes = code === BACKSLASH ? backslashes + 1 : 0
      prevCode = code
      effects.consume(code)
      return data
    }

    const sequenceClose: State = (code) => {
      if (code === DOLLAR) {
        effects.consume(code)
        size += 1
        return sequenceClose
      }
      if (size === sizeOpen) {
        if (sizeOpen === 1 && (prevCode === null || isWhitespace(prevCode) || isAsciiDigit(code))) {
          return nok(code)
        }
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return ok(code)
      }
      if (sizeOpen === 1) {
        // Avoid swallowing a later `$$...$$` display math delimiter from an earlier literal `$50`.
        return nok(code)
      }
      if (token) {
        token.type = 'mathTextData'
      }
      prevCode = DOLLAR
      backslashes = 0
      return data(code)
    }

    return start
  }

  return {
    ...base,
    text: {
      ...base.text,
      [DOLLAR]: {
        ...baseConstruct,
        tokenize,
      },
    },
  }
}
