import { Button, IconCheckedOutline14 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { AskUserQuestion, AskUserState, PendingAskUser } from './askUser.js'
import { askUserMessages } from './messages.js'
import styles from './AskUserCard.module.css'

const hasAnswer = (value: string | string[] | undefined): boolean =>
  Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0

const AskUserCardBody = ({
  pending,
  onStopReply,
}: {
  pending: PendingAskUser
  onStopReply: () => void
}) => {
  const t = askUserMessages.useTranslate()
  const { questions, submit, skip } = pending
  const isSingleQuestion = questions.length === 1
  const [activeIndex, setActiveIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const [customById, setCustomById] = useState<Record<string, string>>({})
  const [validationError, setValidationError] = useState<string | null>(null)

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
    setValidationError(null)
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
      setValidationError(null)
      setActiveIndex((idx) => Math.min(idx + 1, questions.length - 1))
      return
    }
    const finalAnswers = buildFinalAnswers()
    if (Object.keys(finalAnswers).length === 0) {
      setValidationError(t('askEmptyError'))
      return
    }
    setValidationError(null)
    submit(finalAnswers)
  }

  const currentAnswered =
    hasAnswer(currentValue) || (current.allowCustom && currentCustom.trim().length > 0)

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

  const showPrimaryAction =
    current.multiSelect || !current.options?.length || isLast || currentAnswered
  const showBack = activeIndex > 0
  const showFooter =
    (!isSingleQuestion && (showPrimaryAction || showBack)) ||
    (isSingleQuestion && (current.multiSelect || !current.options?.length))

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
                    onClick={() => {
                      setValidationError(null)
                      setActiveIndex(index)
                    }}
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
        <div className={styles.headerActions}>
          <button type="button" className={styles.headerAction} onClick={skip}>
            {t('askSkip')}
          </button>
          <button type="button" className={styles.headerAction} onClick={onStopReply}>
            {t('askStop')}
          </button>
        </div>
      </div>

      <p className={styles.question}>{current.question}</p>

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
                role={current.multiSelect ? 'checkbox' : undefined}
                aria-checked={current.multiSelect ? selected : undefined}
                aria-pressed={current.multiSelect ? undefined : selected}
                className={clsx(styles.option, selected && styles.optionSelected)}
                onClick={() => pickOption(opt.label)}
              >
                {current.multiSelect ? (
                  <span
                    className={clsx(styles.checkbox, selected && styles.checkboxChecked)}
                    aria-hidden="true"
                  >
                    {selected ? <IconCheckedOutline14 /> : null}
                  </span>
                ) : (
                  <span className={styles.optionIndex} aria-hidden="true">
                    {selected ? <IconCheckedOutline14 /> : index + 1}
                  </span>
                )}
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
          {current.options?.length ? (
            <span className={styles.customLead} aria-hidden="true">
              +
            </span>
          ) : null}
          <input
            type="text"
            className={styles.customInput}
            aria-label={current.options?.length ? t('askOtherLabel') : current.question}
            value={currentCustom}
            placeholder={
              current.options?.length ? t('askOtherPlaceholder') : t('askFreeTextPlaceholder')
            }
            onChange={(event) => {
              const text = event.target.value
              setValidationError(null)
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
          {isSingleQuestion &&
          !current.multiSelect &&
          current.options?.length &&
          currentCustom.trim() ? (
            <Button variant="primary" size="s" onClick={handleSubmitOrNext}>
              {t('askSubmit')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {showFooter ? (
        <div className={styles.footer}>
          {validationError ? (
            <span className={styles.errorText} role="alert">
              {validationError}
            </span>
          ) : null}
          <div className={styles.footerButtons}>
            {showBack ? (
              <Button
                variant="outlined"
                size="s"
                onClick={() => {
                  setValidationError(null)
                  setActiveIndex((idx) => Math.max(0, idx - 1))
                }}
              >
                {t('askBack')}
              </Button>
            ) : null}
            {showPrimaryAction ? (
              <Button variant="primary" size="s" onClick={handleSubmitOrNext}>
                {isLast ? t('askSubmit') : t('askNext')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export const createAskUserDock = (state: AskUserState) => {
  const ComposerDock = ({
    sessionId,
    onStopReply,
  }: {
    sessionId: string
    onStopReply: () => void
  }) => {
    const pending = state.useStore((s) => s.pendingBySession[sessionId])
    if (!pending) {
      return null
    }
    return (
      <AskUserCardBody
        key={pending.questions.map((q) => q.id).join(',')}
        pending={pending}
        onStopReply={onStopReply}
      />
    )
  }
  return ComposerDock
}
