import BrandLogo from './BrandLogo';
import { useEffect, useMemo, useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';
import { formatSize, isInlineImage } from './api';
import { LanguageSelect, useLanguage } from './i18n';
import { MarkdownContent } from './NoteCard';
import type { Attachment } from './types';

interface SharedNote {
  note: { content: string; createdAt: number; updatedAt: number; attachments: Attachment[] };
  expiresAt: number;
}

export default function SharePage() {
  const { t, locale } = useLanguage();
  const token = /^\/s\/([a-f0-9]{64})\/?$/.exec(window.location.pathname)?.[1];
  const [shared, setShared] = useState<SharedNote | null>(null);
  const [loading, setLoading] = useState(!!token);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    let request = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    async function refresh() {
      const current = ++request;
      controller?.abort();
      controller = new AbortController();
      clearTimeout(expiry);
      // Clear the old response before refreshing: a suspended tab may have expired.
      setShared(null);
      setLoading(true);
      try {
        const response = await fetch(`/s/${token}/note`, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        const result = await response.json() as SharedNote;
        if (!alive || current !== request) return;
        const remaining = result.expiresAt - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('expired');
        setShared(result);
        expiry = setTimeout(() => setShared(null), remaining);
      } catch { if (alive && current === request) setShared(null); }
      finally { if (alive && current === request) setLoading(false); }
    }
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { alive = false; controller?.abort(); clearTimeout(expiry); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility); };
  }, [token]);

  const attachments = useMemo(() => (shared?.note.attachments || []).filter(attachment =>
    /^[a-zA-Z0-9_-]+$/.test(attachment.id) && attachment.url === `/s/${token}/files/${attachment.id}`), [shared, token]);
  const attachmentLinks = useMemo(() => new Map(attachments.flatMap(attachment => [[`/files/${attachment.id}`, attachment.url], [attachment.url, attachment.url]])), [attachments]);
  return <main className="share-page">
    <header className="share-page-header"><div className="brand"><BrandLogo /><span>Tutus<small className="brand-caption">{t('只读分享', 'Read-only share')}</small></span></div><LanguageSelect className="compact" /></header>
    {loading ? <section className="share-unavailable" role="status"><LoaderCircle size={21} className="spin" /><p>{t('正在打开分享…', 'Opening the shared note…')}</p></section>
      : !shared ? <section className="share-unavailable"><h1>{t('分享已失效或不存在', 'This share has expired or is unavailable')}</h1><p>{t('分享链接有效期为 24 小时，请联系分享者获取新链接。', 'Share links last 24 hours. Ask the sender for a new link.')}</p></section>
        : <article className="note-card shared-note"><div className="note-header"><time dateTime={new Date(shared.note.createdAt).toISOString()}>{new Date(shared.note.createdAt).toLocaleString(locale)}</time>{shared.note.updatedAt > shared.note.createdAt + 1000 && <span className="note-meta">{t('已编辑', 'Edited')}</span>}</div><MarkdownContent content={shared.note.content} attachmentLinks={attachmentLinks} />
          {attachments.filter(attachment => !isInlineImage(attachment.mime) || !shared.note.content.includes(`/files/${attachment.id}`)).length > 0 && <div className="note-files">{attachments.filter(attachment => !isInlineImage(attachment.mime) || !shared.note.content.includes(`/files/${attachment.id}`)).map(attachment => <a className="file-link" key={attachment.id} href={attachment.url} target="_blank" rel="noopener noreferrer"><FileText size={17} /><span>{attachment.filename}<small>{formatSize(attachment.size)}</small></span></a>)}</div>}
          <footer className="shared-note-footer">{t('只读 · 链接失效时间：', 'Read-only · Link expires: ')}{new Date(shared.expiresAt).toLocaleString(locale)}</footer>
        </article>}
  </main>;
}
