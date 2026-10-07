import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, Copy, FileText, LoaderCircle, Pencil, Pin, Share2, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, errorMessage, formatSize, isInlineImage } from './api';
import type { Note } from './types';
import { useLanguage } from './i18n';

// A public note may resolve local links only through this note's attachment map.
// In particular, opening a share while signed in must never render private files.
function scopedLink(source: string | undefined, attachments: ReadonlyMap<string, string>): { url?: string; image: boolean } {
  if (!source) return { image: false };
  try {
    const url = new URL(source, window.location.origin);
    if (url.origin !== window.location.origin) return { url: ['http:', 'https:', 'mailto:'].includes(url.protocol) ? source : undefined, image: false };
    if (url.search || url.hash) return { image: false };
    const shared = attachments.get(url.pathname);
    return shared ? { url: shared, image: true } : { image: false };
  } catch { return { image: false }; }
}

export function MarkdownContent({ content, attachmentLinks }: { content: string; attachmentLinks?: ReadonlyMap<string, string> }) {
  const { t } = useLanguage();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, node: _node, ...props }) => {
      const href = attachmentLinks ? scopedLink(props.href, attachmentLinks).url : props.href;
      return href ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: ({ node: _node, ...props }) => {
      const src = typeof props.src === 'string' ? props.src : undefined;
      const resolved = attachmentLinks ? scopedLink(src, attachmentLinks) : { url: src, image: !!src && /^\/files\/[a-zA-Z0-9_-]+$/.test(src) };
      if (resolved.image && resolved.url) return <a href={resolved.url} target="_blank" rel="noopener noreferrer" className="note-image-link"><img {...props} src={resolved.url} loading="lazy" alt={props.alt || t('笔记图片', 'Note image')} /></a>;
      if (resolved.url) return <a href={resolved.url} target="_blank" rel="noopener noreferrer">{t('外部图片：', 'External image: ')}{props.alt || t('点击打开', 'Open image')}</a>;
      return <span className="muted">{props.alt || t('图片未包含在分享中', 'This image is not included in the share')}</span>;
    },
  }}>{content}</ReactMarkdown></div>;
}

export default function NoteCard({ note, busy, onEdit, onAction, onTag }: { note: Note; busy: boolean; onEdit: () => void; onAction: (note: Note, action: 'pin' | 'archive' | 'delete') => void; onTag: (tag: string) => void }) {
  const { t, locale } = useLanguage();
  const [share, setShare] = useState<{ url: string; expiresAt: number } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<unknown>(null);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'manual' | null>(null);
  const shareInput = useRef<HTMLInputElement>(null);
  async function prepareShare(copy = false) {
    setSharing(true);
    setShareError(null);
    setCopyStatus(null);
    try {
      const result = await api<{ share: { url: string; expiresAt: number } }>(`/api/notes/${encodeURIComponent(note.id)}/share`, { method: 'POST', body: '{}' });
      const next = { ...result.share, url: new URL(result.share.url, window.location.origin).href };
      setShare(next);
      if (copy) {
        try { await navigator.clipboard.writeText(next.url); setCopyStatus('copied'); }
        catch { setCopyStatus('manual'); requestAnimationFrame(() => { shareInput.current?.focus(); shareInput.current?.select(); }); }
      }
    } catch (error) { setShareError(error); }
    finally { setSharing(false); }
  }
  const date = new Date(note.createdAt);
  const label = date.toLocaleString(locale, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <article className={`note-card ${note.pinned ? 'is-pinned' : ''}`}>
    <div className="note-header"><time dateTime={date.toISOString()} title={date.toLocaleString(locale)}>{label}{date.getFullYear() !== new Date().getFullYear() && ` · ${date.getFullYear()}`}</time><span className="note-meta">{note.pinned && <span><Pin size={12} /> {t('置顶', 'Pinned')}</span>}{note.updatedAt > note.createdAt + 1000 && <span title={new Date(note.updatedAt).toLocaleString(locale)}>{t('已编辑', 'Edited')}</span>}</span></div>
    <MarkdownContent content={note.content} />
    {note.attachments.filter(attachment => !isInlineImage(attachment.mime) || !note.content.includes(attachment.url)).length > 0 && <div className="note-files">{note.attachments.filter(attachment => !isInlineImage(attachment.mime) || !note.content.includes(attachment.url)).map(attachment => <a className="file-link" key={attachment.id} href={attachment.url} target="_blank" rel="noopener noreferrer"><FileText size={17} /><span>{attachment.filename}<small>{formatSize(attachment.size)}</small></span></a>)}</div>}
    <div className="note-footer"><div className="note-tags">{note.tags.map(tag => <button type="button" className="tag" key={tag} onClick={() => onTag(tag)}>#{tag}</button>)}</div><div className="note-actions">{busy && <LoaderCircle size={14} className="spin" />}<button className="button small note-share-button" type="button" onClick={() => void prepareShare()} disabled={busy || sharing} title={t('持有链接的人可查看这条笔记及其附件，24 小时后失效。', 'Anyone with the link can view this note and its attachments for 24 hours.')}><Share2 size={14} />{t('分享', 'Share')}</button><button className="icon-button small" type="button" onClick={onEdit} disabled={busy} title={t('编辑', 'Edit')} aria-label={t('编辑笔记', 'Edit note')}><Pencil size={15} /></button><button className={`icon-button small ${note.pinned ? 'selected' : ''}`} type="button" onClick={() => onAction(note, 'pin')} disabled={busy} title={note.pinned ? t('取消置顶', 'Unpin') : t('置顶', 'Pin')} aria-label={note.pinned ? t('取消置顶', 'Unpin note') : t('置顶笔记', 'Pin note')}><Pin size={15} /></button><button className="icon-button small" type="button" onClick={() => onAction(note, 'archive')} disabled={busy} title={note.archived ? t('恢复笔记', 'Restore note') : t('归档', 'Archive')} aria-label={note.archived ? t('恢复笔记', 'Restore note') : t('归档笔记', 'Archive note')}>{note.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}</button><button className="icon-button small danger" type="button" onClick={() => onAction(note, 'delete')} disabled={busy} title={t('永久删除', 'Delete permanently')} aria-label={t('永久删除笔记', 'Delete note permanently')}><Trash2 size={15} /></button></div></div>
    {share && <div className="note-share-panel"><p>{t('链接生成后 24 小时有效，持有链接的人可只读查看这条笔记及其附件。', 'The link lasts 24 hours. Anyone with it can read this note and its attachments.')}</p><div className="note-share-link"><input ref={shareInput} aria-label={t('分享链接', 'Share link')} value={share.url} readOnly onFocus={event => event.currentTarget.select()} /><button type="button" className="button secondary small" disabled={busy || sharing} onClick={() => void prepareShare(true)}>{sharing ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}{t('复制链接', 'Copy link')}</button></div><small>{t('失效时间：', 'Expires: ')}{new Date(share.expiresAt).toLocaleString(locale)}</small>{copyStatus && <p role="status" className={copyStatus === 'copied' ? 'success' : 'muted'}>{copyStatus === 'copied' ? t('链接已复制', 'Link copied') : t('未能自动复制，请选中上方链接手动复制。', 'Automatic copying was unavailable. Select the link above and copy it manually.')}</p>}</div>}
    {shareError != null && <div className="error note-share-error" role="alert">{errorMessage(shareError)}</div>}
  </article>;
}
