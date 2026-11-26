import {
  ChapterRail,
  RollingNumber,
  createScrollGlide,
  onScrollIntent,
  type ChapterRailHandle,
  type ScrollGlide,
} from '@deepseek-chat/lib-ui'
import { useEffect, useRef, useState } from 'react'
import styles from './Workbench.module.css'

const CHAPTERS = [
  'Choosing a type scale',
  'Spacing on a 4px grid',
  'Two weights are enough',
  'Colour roles before colours',
  'Elevation in dark mode',
  'Motion tokens and reduced motion',
  'Focus that is always visible',
  'Targets for coarse pointers',
  'Empty, loading and error states',
  'Copy in the reader’s words',
]

const paragraphs = (index: number) =>
  Array.from({ length: 2 + (index % 3) }, (_, line) => (
    <p key={line} className={styles.chapterDemoText}>
      Chapter {index + 1}, paragraph {line + 1}. Sample text that gives each chapter a different
      length, so the viewport bar on the rail grows and shrinks as you scroll through it.
    </p>
  ))

/** Dev-only playground for ChapterRail, RollingNumber and the scroll glide on a long scroller. */
export const ChapterRailDemo = () => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<ChapterRailHandle>(null)
  const glideRef = useRef<ScrollGlide | null>(null)
  const lockRef = useRef<number | null>(null)
  const [current, setCurrent] = useState(0)
  const [returnTo, setReturnTo] = useState<number | null>(null)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const glide = createScrollGlide(scroller)
    glideRef.current = glide
    const sections = () => [...scroller.querySelectorAll<HTMLElement>('[data-chapter]')]
    let frame = 0
    const paint = () => {
      frame = 0
      const tops = sections().map((section) => section.offsetTop)
      const position = (y: number) => {
        let index = 0
        tops.forEach((top, i) => {
          if (top <= y) {
            index = i
          }
        })
        const end = tops[index + 1] ?? scroller.scrollHeight
        return index + Math.min(1, (y - (tops[index] ?? 0)) / Math.max(1, end - (tops[index] ?? 0)))
      }
      railRef.current?.setViewport(
        position(scroller.scrollTop),
        position(scroller.scrollTop + scroller.clientHeight)
      )
      if (lockRef.current === null) {
        setCurrent(Math.floor(position(scroller.scrollTop + scroller.clientHeight * 0.3)))
      }
    }
    const onScroll = () => {
      frame ||= requestAnimationFrame(paint)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const stopIntent = onScrollIntent(scroller, () => {
      lockRef.current = null
      glide.cancel()
    })
    paint()
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      stopIntent()
      glide.cancel()
    }
  }, [])

  const go = (index: number, instant = false) => {
    const scroller = scrollRef.current
    const section = scroller?.querySelector<HTMLElement>(`[data-chapter="${index}"]`)
    if (!scroller || !section) {
      return
    }
    lockRef.current = index
    setCurrent(index)
    glideRef.current?.to(section.offsetTop, {
      instant,
      fade: scroller.firstElementChild as HTMLElement | null,
    })
  }

  return (
    <div className={styles.chapterDemo}>
      <div className={styles.chapterDemoHeader}>
        <span>
          Chapter <RollingNumber value={current + 1} /> of {CHAPTERS.length}
        </span>
      </div>
      <div className={styles.chapterDemoBody}>
        <div ref={scrollRef} className={styles.chapterDemoScroll}>
          <div>
            {CHAPTERS.map((title, index) => (
              <section key={title} data-chapter={index} className={styles.chapterDemoSection}>
                <h4 className={styles.chapterDemoTitle}>{title}</h4>
                {paragraphs(index)}
              </section>
            ))}
          </div>
        </div>
        <div className={styles.chapterDemoGutter}>
          <ChapterRail
            ref={railRef}
            items={CHAPTERS.map((title, index) => ({
              key: title,
              label: title,
              accessibleLabel: `Chapter ${index + 1}: ${title}`,
              ...(index === 6 ? { dividerBefore: 'Accessibility' } : {}),
            }))}
            current={current}
            ariaLabel="Chapters"
            returnTo={
              returnTo === null
                ? null
                : {
                    index: returnTo,
                    label: `Back to chapter ${returnTo + 1}`,
                    onReturn: () => {
                      setReturnTo(null)
                      go(returnTo)
                    },
                  }
            }
            onNavigate={(index, how) => {
              if (how === 'jump' && Math.abs(index - current) > 2) {
                setReturnTo(current)
              }
              go(index, how === 'scrub')
            }}
            onScrubEnd={(index, from) => {
              if (Math.abs(index - from) > 2) {
                setReturnTo(from)
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
