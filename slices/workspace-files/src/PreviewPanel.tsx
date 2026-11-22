import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16,
  IconBrowserOutline14,
  IconButton,
  IconCheckOutline16,
  IconCloseOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconRefreshOutline16,
  ViewportMenu,
  fitViewportToStage,
  panelStyles,
  showToast,
} from '@deepseek-chat/spine/design'
import { useWorkspace, WorkspaceProvider, type WorkspaceEnv } from './context.js'
import { classifyPreviewKind, isTextPreviewKind, supportsPreviewToggle } from './fileKinds.js'
import { FileSwitcherMenu, type PreviewFileItem } from './FileSwitcherMenu.js'
import { workspaceMessages } from './messages.js'
import styles from './PreviewPanel.module.css'
import { EMPTY_SESSION_PREVIEW_STATE } from './state.js'
import { VersionMenu } from './VersionMenu.js'
import { BinaryFallback } from './viewers/BinaryFallback.js'
import { CodePreview } from './viewers/CodePreview.js'
import { HtmlPreview } from './viewers/HtmlPreview.js'
import { ImagePreview } from './viewers/ImagePreview.js'
import { MarkdownPreview } from './viewers/MarkdownPreview.js'
import { MermaidPreview } from './viewers/MermaidPreview.js'
import { PdfPreview } from './viewers/PdfPreview.js'
import { TablePreview } from './viewers/TablePreview.js'
import {
  collectUserUploadEntries,
  collectWorkspaceArtifacts,
  makeUploadPreviewKey,
  type FileRecord,
  type FileVersionEntry,
} from './workspace.js'

type LoadedFilePayload = {
  fileId: string
  blob: Blob | null
  bytes: Uint8Array | null
  text: string | null
  blobUrl: string | null
  missing: boolean
}

/** 右侧文件预览面板：提供本 slice 的依赖给各预览视图 */
export const createPreviewPanel = (env: WorkspaceEnv) => {
  const PreviewPanel = ({
    records,
    topActions,
  }: {
    /** Files of the active chat's visible branch, in conversation order. */
    records: readonly FileRecord[]
    topActions?: ReactNode
  }) => (
    <WorkspaceProvider value={env}>
      <PreviewPanelContent records={records} topActions={topActions} />
    </WorkspaceProvider>
  )
  return PreviewPanel
}

/** 右侧文件预览面板内容（托管在共享 SidePanel 壳层内，单行 52px 顶栏） */
const PreviewPanelContent = ({
  records,
  topActions,
}: {
  records: readonly FileRecord[]
  topActions?: ReactNode
}) => {
  const t = workspaceMessages.useTranslate()
  const env = useWorkspace()
  const isDesktopApp = env.host !== null
  const {
    closePreviewPanel,
    selectPreviewFile,
    selectPreviewVersion,
    setPreviewViewMode,
    setPreviewViewport,
    usePreviewStore,
  } = env.state
  const activeSessionId = env.panel.useLayout((layout) => layout.activeSessionId)
  const stageSize = env.panel.useStageSize()
  const sessionPreview = usePreviewStore((state) =>
    activeSessionId && Object.hasOwn(state.sessions, activeSessionId)
      ? state.sessions[activeSessionId]
      : EMPTY_SESSION_PREVIEW_STATE
  )

  const [actualImageSize, setActualImageSize] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [loaded, setLoaded] = useState<LoadedFilePayload | null>(null)

  const artifacts = useMemo(() => collectWorkspaceArtifacts(records), [records])
  const uploads = useMemo(() => collectUserUploadEntries(records), [records])

  // 收集当前分支内可用于预览的文件条目（产物 + 已打开过的上传附件）
  const items = useMemo(() => {
    const byKey = new Map<string, { versions: FileVersionEntry[]; title: string }>()
    for (const art of artifacts) {
      byKey.set(art.key, {
        versions: art.versions,
        title: art.title || art.name,
      })
    }
    const uploadMap = new Map<string, FileVersionEntry>()
    for (const up of uploads) {
      uploadMap.set(makeUploadPreviewKey(up.fileId), up)
    }

    const keys: string[] = artifacts.map((a) => a.key)
    for (const upKey of sessionPreview.uploadKeys) {
      if (uploadMap.has(upKey) && !byKey.has(upKey)) {
        const up = uploadMap.get(upKey)
        if (up) {
          byKey.set(upKey, { versions: [up], title: up.name })
          keys.push(upKey)
        }
      }
    }
    if (
      sessionPreview.activeKey &&
      !byKey.has(sessionPreview.activeKey) &&
      uploadMap.has(sessionPreview.activeKey)
    ) {
      const up = uploadMap.get(sessionPreview.activeKey)
      if (up) {
        byKey.set(sessionPreview.activeKey, { versions: [up], title: up.name })
        keys.push(sessionPreview.activeKey)
      }
    }

    const result: PreviewFileItem[] = []
    for (const key of keys) {
      const match = byKey.get(key)
      if (!match || match.versions.length === 0) {
        continue
      }
      const pinnedId = sessionPreview.selectedFileIdByKey[key]
      const active =
        (pinnedId ? match.versions.find((v) => v.fileId === pinnedId) : undefined) ??
        match.versions.at(-1)
      if (!active) {
        continue
      }
      result.push({
        key,
        title: active.title || active.name,
        name: active.name,
        versions: match.versions,
        active,
      })
    }
    return result
  }, [
    artifacts,
    uploads,
    sessionPreview.uploadKeys,
    sessionPreview.activeKey,
    sessionPreview.selectedFileIdByKey,
  ])

  const activeItem =
    items.find((item) => item.key === sessionPreview.activeKey) ?? items.at(-1) ?? null
  const activeEntry = activeItem?.active ?? null
  const activeKind = activeEntry
    ? classifyPreviewKind(activeEntry.name, activeEntry.mimeType)
    : null
  const canToggleMode = activeKind !== null && supportsPreviewToggle(activeKind)
  const storedMode = activeItem ? sessionPreview.viewModeByKey[activeItem.key] : undefined
  const effectiveMode = canToggleMode ? (storedMode ?? 'preview') : 'preview'
  const activeViewport = activeItem ? (sessionPreview.viewportByKey[activeItem.key] ?? null) : null
  const viewportZoom =
    activeViewport && stageSize
      ? fitViewportToStage(activeViewport, stageSize.width, stageSize.height).zoom
      : 1

  // 从 IndexedDB 读取当前激活文件原件
  useEffect(() => {
    const fileId = activeEntry?.fileId
    if (!fileId) {
      setLoaded(null)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setActualImageSize(false)
    setCopied(false)

    void (async () => {
      const blob = await env.loadFile(fileId)
      if (cancelled) {
        return
      }
      if (!blob) {
        setLoaded({
          fileId,
          blob: null,
          bytes: null,
          text: null,
          blobUrl: null,
          missing: true,
        })
        return
      }
      const kind = classifyPreviewKind(activeEntry.name, activeEntry.mimeType)
      const needsBytes = kind === 'html' || kind === 'pdf'
      const needsText = isTextPreviewKind(kind)
      const needsUrl = kind === 'image' || kind === 'svg' || (kind === 'pdf' && !isDesktopApp)

      const buffer = needsBytes ? await blob.arrayBuffer() : null
      if (cancelled) {
        return
      }
      const bytes = buffer ? new Uint8Array(buffer) : null
      const text = needsText
        ? buffer
          ? new TextDecoder().decode(buffer)
          : await blob.text()
        : null
      if (cancelled) {
        return
      }
      if (needsUrl) {
        const typedBlob =
          blob.type || !activeEntry.mimeType
            ? blob
            : new Blob([blob], { type: activeEntry.mimeType })
        objectUrl = URL.createObjectURL(typedBlob)
      }
      setLoaded({
        fileId,
        blob,
        bytes,
        text,
        blobUrl: objectUrl,
        missing: false,
      })
    })()

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [activeEntry?.fileId, activeEntry?.name, activeEntry?.mimeType, env, isDesktopApp])

  const activeLoaded = loaded && activeEntry && loaded.fileId === activeEntry.fileId ? loaded : null

  const renderContent = () => {
    if (!activeItem || !activeEntry || !activeKind) {
      return (
        <div className={panelStyles.emptyState}>
          <div className={panelStyles.emptyIcon}>
            <IconBrowseOutline16 />
          </div>
          <div className={panelStyles.emptyTitle}>{t('previewEmptyTitle')}</div>
          <div className={panelStyles.emptyDesc}>{t('previewEmptyDescription')}</div>
        </div>
      )
    }

    if (!activeLoaded) {
      return null
    }

    if (activeLoaded.missing || !activeLoaded.blob) {
      return (
        <BinaryFallback
          name={activeEntry.name}
          size={activeEntry.size}
          mimeType={activeEntry.mimeType}
          missing
        />
      )
    }

    if (effectiveMode === 'code' || activeKind === 'code') {
      return (
        <CodePreview
          text={activeLoaded.text ?? ''}
          name={activeEntry.name}
          mimeType={activeEntry.mimeType}
        />
      )
    }

    switch (activeKind) {
      case 'html':
        return (
          <HtmlPreview
            html={activeLoaded.text ?? ''}
            bytes={activeLoaded.bytes ?? new Uint8Array()}
            title={activeItem.title}
            viewport={activeViewport}
            reloadKey={reloadKey}
            onViewportCommit={(next) =>
              activeSessionId && setPreviewViewport(activeSessionId, activeItem.key, next)
            }
          />
        )
      case 'markdown':
        return <MarkdownPreview text={activeLoaded.text ?? ''} cacheKey={activeEntry.fileId} />
      case 'mermaid':
        return <MermaidPreview text={activeLoaded.text ?? ''} />
      case 'table':
        return (
          <TablePreview
            text={activeLoaded.text ?? ''}
            name={activeEntry.name}
            mimeType={activeEntry.mimeType}
          />
        )
      case 'svg':
      case 'image':
        return activeLoaded.blobUrl ? (
          <ImagePreview
            blobUrl={activeLoaded.blobUrl}
            name={activeEntry.name}
            size={activeEntry.size}
            actualSize={actualImageSize}
            onToggleActualSize={() => setActualImageSize((value) => !value)}
          />
        ) : null
      case 'pdf':
        return (
          <PdfPreview
            blobUrl={activeLoaded.blobUrl ?? ''}
            bytes={activeLoaded.bytes ?? new Uint8Array()}
            name={activeEntry.name}
            reloadKey={reloadKey}
            onSave={() => {
              if (activeLoaded.blob) {
                void env.saveFile(activeEntry.name, activeLoaded.blob)
              }
            }}
          />
        )
      case 'binary':
      default:
        return (
          <BinaryFallback
            name={activeEntry.name}
            size={activeEntry.size}
            mimeType={activeEntry.mimeType}
            onSave={() => {
              if (activeLoaded.blob) {
                void env.saveFile(activeEntry.name, activeLoaded.blob)
              }
            }}
          />
        )
    }
  }

  return (
    <>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft} data-tauri-drag-region>
          {activeItem ? (
            <FileSwitcherMenu
              items={items}
              current={activeItem}
              onSelect={(key) => activeSessionId && selectPreviewFile(activeSessionId, key)}
            />
          ) : (
            <div className={styles.headerTitleStatic} data-tauri-drag-region>
              <span className={styles.headerTitleText}>{t('previewPanelTitle')}</span>
            </div>
          )}
          {activeItem && activeEntry ? (
            <VersionMenu
              versions={activeItem.versions}
              selectedFileId={activeEntry.fileId}
              onSelect={(fileId) =>
                activeSessionId && selectPreviewVersion(activeSessionId, activeItem.key, fileId)
              }
            />
          ) : null}
        </div>

        <div className={styles.headerControls}>
          {activeItem && activeEntry && canToggleMode ? (
            <div className={styles.segmented} role="group">
              <button
                type="button"
                className={styles.segmentBtn}
                aria-pressed={effectiveMode === 'preview'}
                onClick={() =>
                  activeSessionId && setPreviewViewMode(activeSessionId, activeItem.key, 'preview')
                }
              >
                {t('previewModePreview')}
              </button>
              <button
                type="button"
                className={styles.segmentBtn}
                aria-pressed={effectiveMode === 'code'}
                onClick={() =>
                  activeSessionId && setPreviewViewMode(activeSessionId, activeItem.key, 'code')
                }
              >
                {t('previewModeCode')}
              </button>
            </div>
          ) : null}

          {activeItem && activeKind === 'html' && effectiveMode === 'preview' ? (
            <>
              <ViewportMenu
                host={env.panel}
                viewport={activeViewport}
                zoom={viewportZoom}
                onSelect={(next) =>
                  activeSessionId && setPreviewViewport(activeSessionId, activeItem.key, next)
                }
              />
              <IconButton
                size="xs"
                icon={<IconRefreshOutline16 />}
                tooltip={t('previewReload')}
                tooltipPlacement="bottom"
                onClick={() => {
                  if (isDesktopApp) {
                    void env.host?.reload()
                  } else {
                    setReloadKey((n) => n + 1)
                  }
                }}
              />
              {isDesktopApp && process.env.NODE_ENV !== 'production' ? (
                <IconButton
                  size="xs"
                  icon={<IconBrowserOutline14 />}
                  tooltip={t('previewOpenDevtools')}
                  tooltipPlacement="bottom"
                  onClick={() => void env.host?.openDevtools()}
                />
              ) : null}
            </>
          ) : null}

          {activeEntry && activeLoaded?.text !== null && activeLoaded?.text !== undefined ? (
            <IconButton
              size="xs"
              icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
              tooltip={t(copied ? 'copied' : 'copy')}
              tooltipPlacement="bottom"
              onClick={() => {
                const content = activeLoaded.text ?? ''
                void env.copyText(content).then((ok) => {
                  if (!ok) {
                    showToast({ text: () => workspaceMessages.translate('copyFailed') })
                    return
                  }
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
            />
          ) : null}

          {activeEntry && activeLoaded?.blob ? (
            <IconButton
              size="xs"
              icon={<IconDownloadOutline16 />}
              tooltip={t('previewSaveFile')}
              tooltipPlacement="bottom"
              onClick={() => {
                if (activeLoaded.blob) {
                  void env.saveFile(activeEntry.name, activeLoaded.blob)
                }
              }}
            />
          ) : null}

          {topActions}

          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            tooltip={t('previewClosePanel')}
            tooltipPlacement="bottom"
            onClick={() => activeSessionId && closePreviewPanel(activeSessionId)}
          />
        </div>
      </div>

      <div className={styles.body}>{renderContent()}</div>
    </>
  )
}
