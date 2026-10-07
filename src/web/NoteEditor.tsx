import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ArrowUp, Check, Eye, FileText, ImagePlus, LoaderCircle, Paperclip, Pencil, X } from 'lucide-react';
import { ApiError, api, errorMessage, formatSize, isInlineImage } from './api';
import type { Attachment, Note } from './types';
import { MarkdownContent } from './NoteCard';
import { draftPrefix } from './drafts';
import { useLanguage } from './i18n';

interface Draft { id: string; content: string; attachments: Attachment[]; updatedAt: number; baseVersion?: number; copyId?: string }
const LIMIT = 10 * 1024 * 1024;
const extensions = [markdown(), EditorView.lineWrapping];
function readDraft(key: string, note?: Note): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value && typeof value.id === 'string' && typeof value.content === 'string' && Array.isArray(value.attachments) && value.attachments.every((attachment: Attachment) => attachment && typeof attachment.id === 'string' && typeof attachment.filename === 'string' && typeof attachment.mime === 'string' && typeof attachment.size === 'number' && typeof attachment.url === 'string') && (!note || value.id === note.id)) return value;
  } catch { /* Invalid local draft never blocks the editor. */ }
  return { id: note?.id || crypto.randomUUID(), content: note?.content || '', attachments: note?.attachments || [], updatedAt: Date.now(), baseVersion: note?.version };
}
function escapeLabel(value: string) { return value.replace(/[\[\]\\]/g, '\\$&'); }
function hasDraft(key: string) { try { return !!localStorage.getItem(key); } catch { return false; } }

export default function NoteEditor({ username, note, onSaved, onCancel, dark }: { username: string; note?: Note; onSaved: (note: Note) => void; onCancel?: () => void; dark: boolean }) {
  const { t } = useLanguage();
  const key = `${draftPrefix(username)}${note?.id || 'new'}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(key, note));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [preview, setPreview] = useState(false);
  const [restored] = useState(() => hasDraft(key));
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const current = useRef(draft);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    current.current = draft;
    const isChanged = note ? draft.content !== note.content || JSON.stringify(draft.attachments.map(a => a.id)) !== JSON.stringify(note.attachments.map(a => a.id)) : !!draft.content || draft.attachments.length > 0;
    try {
      if (isChanged) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [draft, key, note]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const changed = note ? current.current.content !== note.content || JSON.stringify(current.current.attachments.map(a => a.id)) !== JSON.stringify(note.attachments.map(a => a.id)) : current.current.content.length > 0 || current.current.attachments.length > 0;
      if (changed || uploading || busy) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [note, uploading, busy]);
  async function save(asNew = false) {
    if (busy || uploading || composing.current || (!current.current.content.trim() && !current.current.attachments.length)) return;
    if (asNew && !window.confirm(t('原笔记会保留。要把当前草稿另存为一条新笔记吗？', 'Keep the original note and save this draft as a new note?'))) return;
    setBusy(true); setError(''); setConflict(false);
    const submitted = current.current;
    const copyId = asNew ? submitted.copyId || crypto.randomUUID() : undefined;
    if (asNew && !submitted.copyId) setDraft(previous => ({ ...previous, copyId }));
    try {
      const update = note && !asNew;
      const { note: saved } = await api<{ note: Note }>(update ? `/api/notes/${note.id}` : '/api/notes', { method: update ? 'PATCH' : 'POST', body: JSON.stringify({ ...(update ? { version: submitted.baseVersion ?? note.version } : { id: asNew ? copyId : submitted.id }), content: submitted.content, attachmentIds: submitted.attachments.map(a => a.id) }) });
      try { localStorage.removeItem(key); } catch { /* A successful server save must not become a false failure. */ }
      if (alive.current) {
        if (!note) setDraft({ id: crypto.randomUUID(), content: '', attachments: [], updatedAt: Date.now() });
        onSaved(saved);
      }
    } catch (err) { if (alive.current) { setError(errorMessage(err)); setConflict(err instanceof ApiError && (err.code === 'VERSION_CONFLICT' || err.code === 'ID_CONFLICT' || err.status === 404)); } } finally { if (alive.current) setBusy(false); }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || uploading || busy) return;
    if (files.some(file => file.size > LIMIT)) { setError(t('单个附件不能超过 10 MiB，请缩小文件后重试。', 'Each attachment must be 10 MiB or smaller. Reduce the file size and try again.')); return; }
    setUploading(true); setError('');
    try {
      for (const file of files) {
        const { attachment } = await api<{ attachment: Attachment }>('/api/attachments', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-Upload-Id': crypto.randomUUID() }, body: file });
        if (!alive.current) break;
        setDraft(previous => ({ ...previous, attachments: [...previous.attachments, attachment], content: previous.content + `${previous.content.trim() ? '\n\n' : ''}${isInlineImage(attachment.mime) ? '!' : ''}[${escapeLabel(attachment.filename)}](${attachment.url})`, updatedAt: Date.now() }));
      }
    } catch (err) { if (alive.current) setError(errorMessage(err)); } finally { if (alive.current) setUploading(false); }
  }
  function removeAttachment(attachment: Attachment) {
    setDraft(previous => ({ ...previous, attachments: previous.attachments.filter(a => a.id !== attachment.id), content: previous.content.replaceAll(`![${escapeLabel(attachment.filename)}](${attachment.url})`, '').replaceAll(`[${escapeLabel(attachment.filename)}](${attachment.url})`, ''), updatedAt: Date.now() }));
  }
  return <section className={`editor-card ${note ? 'editing' : ''}`} aria-label={note ? t('编辑笔记', 'Edit note') : t('新建笔记', 'New note')}>
    <div className="editor-heading"><span className="editor-avatar"><Pencil size={17} /></span><strong>{note ? t('编辑笔记', 'Edit note') : t('此刻，想记点什么？', 'What’s on your mind?')}</strong><span className="editor-hint">{t('支持 Markdown', 'Markdown supported')}</span></div>
    <div className="editor-body" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229 && !composing.current) { event.preventDefault(); void save(); }
    }}>
      {preview ? <div className="editor-preview"><MarkdownContent content={draft.content || t('*还没有内容，写一点再预览吧。*', '*Write something to preview it here.*')} /></div> : <CodeMirror value={draft.content} extensions={extensions} theme={dark ? 'dark' : 'light'} minHeight={note ? '160px' : '130px'} maxHeight="420px" placeholder={t('写下一个想法… 用 #标签 整理你的笔记', 'Capture a thought… Use #tags to organize your notes')} editable={!busy} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false }} onChange={value => setDraft(previous => ({ ...previous, content: value, updatedAt: Date.now() }))} aria-label={t('笔记内容', 'Note content')} />}
    </div>
    {draft.attachments.length > 0 && <div className="editor-attachments">{draft.attachments.map(attachment => <div className="attachment-chip" key={attachment.id}><FileText size={14} /><span title={attachment.filename}>{attachment.filename}</span><small>{formatSize(attachment.size)}</small><button type="button" className="icon-button small" aria-label={t(`移除附件 ${attachment.filename}`, `Remove attachment ${attachment.filename}`)} disabled={busy || uploading} onClick={() => removeAttachment(attachment)}><X size={13} /></button></div>)}</div>}
    {error && <div className="error editor-message" role="alert">{error}{conflict && <div>{t('你的修改仍在草稿里。可以先保留原记录，再将当前内容另存。', 'Your changes are still in the draft. Keep the original note and save your changes separately.')}<button className="text-button" type="button" disabled={busy || uploading} onClick={() => void save(true)}>{t('将草稿另存为新笔记', 'Save draft as a new note')}</button></div>}</div>}
    {storageError && <div className="error editor-message" role="alert">{t('浏览器未能保存本机草稿。请保持页面打开，并先复制内容妥善保存。', 'Your browser could not save the local draft. Keep this page open and copy your text somewhere safe.')}</div>}
    <div className="editor-toolbar"><div className="editor-tools"><input ref={input} type="file" multiple hidden onChange={upload} /><button className="icon-button" type="button" disabled={busy || uploading} onClick={() => input.current?.click()} title={t('上传图片或文件，单个不超过 10 MiB', 'Upload images or files, up to 10 MiB each')} aria-label={t('上传图片或文件', 'Upload images or files')}><ImagePlus size={19} /></button><button className={`icon-button ${preview ? 'selected' : ''}`} type="button" onClick={() => setPreview(!preview)} aria-label={preview ? t('继续编辑', 'Continue editing') : t('预览 Markdown', 'Preview Markdown')} title={preview ? t('继续编辑', 'Continue editing') : t('预览 Markdown', 'Preview Markdown')}>{preview ? <Pencil size={18} /> : <Eye size={19} />}</button><span className="draft-status">{uploading ? <><LoaderCircle size={12} className="spin" /> {t('正在上传…', 'Uploading…')}</> : storageError ? t('草稿未写入本机', 'Draft not saved locally') : draft.content || draft.attachments.length ? <><Check size={12} /> {restored ? t('草稿已恢复', 'Draft restored') : t('草稿已存本机', 'Draft saved locally')}</> : t('单个附件 ≤ 10 MiB', 'Up to 10 MiB per file')}</span></div><div className="editor-actions">{onCancel && <button className="button subtle" disabled={busy || uploading} type="button" onClick={onCancel}>{t('收起', 'Close')}</button>}<button className="button primary" type="button" onClick={() => void save()} disabled={busy || uploading || (!draft.content.trim() && !draft.attachments.length)}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={15} />}{busy ? t('保存中…', 'Saving…') : note ? t('保存修改', 'Save changes') : t('记下来', 'Save note')}</button></div></div>
    <div className="editor-bottom-hint"><Paperclip size={11} /> {t('图片和文件仅登录后可见', 'Images and files require sign-in')}<span>{t('Ctrl / ⌘ + Enter 保存', 'Ctrl / ⌘ + Enter to save')}</span></div>
  </section>;
}
