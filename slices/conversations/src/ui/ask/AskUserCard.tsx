import { Button, IconCheckedOutline14 } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useAskUserStore, type AskUserQuestion, type PendingAskUser } from '../../askUser.js'
import { useTranslate } from '../../messages.js'
import styles from './AskUserCard.module.css'

const hasAnswer = (value: string | string[] | undefined): boolean =>
  Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0

const AskUserCardBody = ({ pending }: { pending: PendingAskUser }) => {
  const t = useTranslate()
  const { questions, submit, skip } = pending
  const isSingleQuestion = questions.length === 1
  const [activeIndex, setActiveIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [customById, setCustomById] = useState<Record<string, string>>({})

  const current: AskUserQuestion = questions[activeIndex] ?? questions[0]
  const currentValue = answers[current.id]
  const currentCustom = customById[current.id] ?? ''
  const isLast = activeIndex === questions.length - 1

  const buildFinalAnswers = (
    overrideAnswers: Record<string, string | string[]> = answers,
    overrideCustom: Record<string, string> = customById
  ): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {}
    for (const q of questions) {
      const custom = (overrideCustom[q.id] ?? '').trim()
      const val = overrideAnswers[q.id]
      if (q.multiSelect) {
        const list = Array.isArray(val) ? [...val] : []
        if (custom && !list.includes(custom)) {
          list.push(custom)
        }
        if (list.length > 0) {
          out[q.id] = list
        }
      } else if (custom) {
        out[q.id] = custom
      } else if (typeof val === 'string' && val.trim()) {
        out[q.id] = val.trim()
      }
    }
    return out
  }

  const pickOption = (label: string) => {
    if (current.multiSelect) {
      setAnswers((prev) => {
        const existing = Array.isArray(prev[current.id]) ? (prev[current.id] as string[]) : []
        const next = existing.includes(label)
          ? existing.filter((item) => item !== label)
          : [...existing, label]
        return { ...prev, [current.id]: next }
      })
      return
    }
    const nextAnswers = { ...answers, [current.id]: label }
    const nextCustom = { ...customById, [current.id]: '' }
    setAnswers(nextAnswers)
    setCustomById(nextCustom)
    // Single-question single-select submits immediately in 1 click.
    if (isSingleQuestion) {
      submit(buildFinalAnswers(nextAnswers, nextCustom))
      return
    }
    if (!isLast) {
      setActiveIndex((idx) => Math.min(idx + 1, questions.length - 1))
    }
  }

  const handleSubmitOrNext = () => {
    if (!isLast) {
      setActiveIndex((idx) => Math.min(idx + 1, questions.length - 1))
      return
    }
    const finalAnswers = buildFinalAnswers()
    if (Object.keys(finalAnswers).length === 0) {
      return
    }
    submit(finalAnswers)
  }

  const currentAnswered =
    hasAnswer(currentValue) || (current.allowCustom && currentCustom.trim().length > 0)
  const anyAnswered = questions.some(
    (q) => hasAnswer(answers[q.id]) || (q.allowCustom && (customById[q.id] ?? '').trim().length > 0)
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        skip()
        return
      }
      const target = event.target as HTMLElement | null
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if (inField) {
        return
      }
      if (current.options && event.key >= '1' && event.key <= '4') {
        const opt = current.options[Number(event.key) - 1]
        if (opt) {
          event.preventDefault()
          pickOption(opt.label)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const showFooter = !isSingleQuestion || current.multiSelect || !current.options?.length

  return (
    <div className={styles.card} role="region" aria-label={t('askCardTitle')}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {questions.length > 1 ? (
            <div className={styles.tabs} role="tablist">
              {questions.map((q, index) => {
                const done =
                  hasAnswer(answers[q.id]) ||
                  (q.allowCustom && (customById[q.id] ?? '').trim().length > 0)
                return (
                  <button
                    key={q.id}
                    type="button"
                    role="tab"
                    aria-selected={index === activeIndex}
                    className={styles.tab}
                    onClick={() => setActiveIndex(index)}
                  >
                    {done ? (
                      <span className={styles.tabCheck}>
                        <IconCheckedOutline14 />
                      </span>
                    ) : null}
                    <span>{q.header}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <span className={styles.titleBadge}>{current.header || t('askCardTitle')}</span>
          )}
        </div>
        <button type="button" className={styles.skipBtn} onClick={skip}>
          {t('askSkip')}
        </button>
      </div>

      <p className={styles.question}>
        {current.question}
        {current.multiSelect ? <span className={styles.multiHint}>{t('askMultiHint')}</span> : null}
      </p>

      {current.options?.length ? (
        <div className={styles.options}>
          {current.options.map((opt, index) => {
            const selected = current.multiSelect
              ? Array.isArray(currentValue) && currentValue.includes(opt.label)
              : currentValue === opt.label && !currentCustom.trim()
            return (
              <button
                key={opt.label}
                type="button"
                className={clsx(styles.option, selected && styles.optionSelected)}
                aria-pressed={selected}
                onClick={() => pickOption(opt.label)}
              >
                <span className={styles.keycap}>
                  {selected ? <IconCheckedOutline14 /> : index + 1}
                </span>
                <span className={styles.optionBody}>
                  <span className={styles.optionTop}>
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {opt.recommended ? (
                      <span className={styles.recommended}>{t('askRecommended')}</span>
                    ) : null}
                  </span>
                  {opt.description ? (
                    <span className={styles.optionDesc}>{opt.description}</span>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      {current.allowCustom ? (
        <div className={styles.customRow}>
          <input
            type="text"
            className={styles.customInput}
            value={currentCustom}
            placeholder={
              current.options?.length ? t('askOtherPlaceholder') : t('askFreeTextPlaceholder')
            }
            onChange={(event) => {
              const text = event.target.value
              setCustomById((prev) => ({ ...prev, [current.id]: text }))
              if (!current.multiSelect && text.trim()) {
                setAnswers((prev) => ({ ...prev, [current.id]: '' }))
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (currentCustom.trim()) {
                  handleSubmitOrNext()
                }
              }
            }}
          />
          {isSingleQuestion && !current.multiSelect && current.options?.length ? (
            <Button
              variant="primary"
              size="s"
              disabled={!currentCustom.trim()}
              onClick={handleSubmitOrNext}
            >
              {t('askSubmit')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showFooter ? (
        <div className={styles.footer}>
          {activeIndex > 0 ? (
            <Button
              variant="outlined"
              size="s"
              onClick={() => setActiveIndex((idx) => Math.max(0, idx - 1))}
            >
              {t('askBack')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="s"
            disabled={isLast ? !anyAnswered : !currentAnswered}
            onClick={handleSubmitOrNext}
          >
            {isLast ? t('askSubmit') : t('askNext')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export const AskUserCard = ({ sessionId }: { sessionId: string }) => {
  const pending = useAskUserStore((state) => state.pendingBySession[sessionId])
  if (!pending) {
    return null
  }
  return <AskUserCardBody key={pending.questions.map((q) => q.id).join(',')} pending={pending} />
}
