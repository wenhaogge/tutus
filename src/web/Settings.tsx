import { useEffect, useState, type FormEvent } from 'react';
import { Check, DatabaseBackup, FileKey2, FileText, LoaderCircle, LockKeyhole, Moon, Sun, Monitor, Trash2, UserRound } from 'lucide-react';
import { api, errorMessage, formatSize } from './api';
import { LanguageSelect, useLanguage } from './i18n';
import type { Attachment, Settings as SettingsType, Theme, User } from './types';

export default function Settings({ user, onUpdate, onPasswordChanged }: { user: User; onUpdate: (settings: SettingsType) => void; onPasswordChanged: () => void }) {
  const { t } = useLanguage();
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [theme, setTheme] = useState<Theme>(user.settings?.theme || 'system');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [looseAttachments, setLooseAttachments] = useState<Attachment[] | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  async function loadAttachments() {
    setAttachmentBusy(true); setAttachmentError('');
    try { const { attachments } = await api<{ attachments: Attachment[] }>('/api/attachments?unreferenced=1'); setLooseAttachments(attachments); } catch (err) { setAttachmentError(errorMessage(err)); } finally { setAttachmentBusy(false); }
  }
  async function removeAttachment(attachment: Attachment) {
    if (!window.confirm(t(`永久删除“${attachment.filename}”？\n这个附件可能仍被未保存的草稿使用。确认不再需要后再删除。`, `Permanently delete “${attachment.filename}”?\nAn unsaved draft may still use this attachment. Delete it only if you no longer need it.`))) return;
    setAttachmentBusy(true); setAttachmentError('');
    try { await api(`/api/attachments/${attachment.id}`, { method: 'DELETE' }); setLooseAttachments(previous => previous?.filter(file => file.id !== attachment.id) || []); } catch (err) { setAttachmentError(errorMessage(err)); } finally { setAttachmentBusy(false); }
  }
  useEffect(() => {
    let active = true;
    api<{ settings: SettingsType }>('/api/settings').then(({ settings }) => { if (active) { setDisplayName(settings.displayName); setTheme(settings.theme || 'system'); } }).catch(err => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { const { settings } = await api<{ settings: SettingsType }>('/api/settings', { method: 'PATCH', body: JSON.stringify({ displayName: displayName.trim(), theme }) }); onUpdate(settings); setSaved(true); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault(); setPasswordError('');
    if (newPassword !== confirmPassword) { setPasswordError(t('两次输入的新密码不一致。', 'The new passwords do not match.')); return; }
    if (new TextEncoder().encode(newPassword).byteLength > 72) { setPasswordError(t('密码不能超过 72 字节；中文字符通常占 3 字节。', 'Passwords must be 72 bytes or fewer. Chinese characters usually use 3 bytes each.')); return; }
    setPasswordBusy(true);
    try { await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); onPasswordChanged(); } catch (err) { setPasswordError(errorMessage(err)); } finally { setPasswordBusy(false); }
  }
  return <div className="settings-list">
    <form className="settings-card" onSubmit={save}>
      <div className="settings-heading"><UserRound size={20} /><div><h2>{t('基本设置', 'General settings')}</h2><p>{t('让这里更像你的私人空间。', 'Make this space feel like yours.')}</p></div></div>
      <LanguageSelect />
      <small className="muted">{t('语言切换立即生效，仅保存在当前浏览器，不改变笔记内容。', 'Language changes apply immediately in this browser. Your notes stay unchanged.')}</small>
      <label>{t('用户名', 'Username')}<input value={user.username} disabled /></label>
      <label>{t('显示名称', 'Display name')}<input value={displayName} onChange={e => { setDisplayName(e.target.value); setSaved(false); }} required maxLength={80} /></label>
      <fieldset><legend>{t('外观', 'Appearance')}</legend><div className="theme-options">{([{ value: 'system', label: t('跟随系统', 'System'), icon: Monitor }, { value: 'light', label: t('浅色', 'Light'), icon: Sun }, { value: 'dark', label: t('深色', 'Dark'), icon: Moon }] as const).map(option => <label className={`theme-option ${theme === option.value ? 'selected' : ''}`} key={option.value}><input type="radio" name="theme" checked={theme === option.value} onChange={() => { setTheme(option.value); setSaved(false); }} /><option.icon size={17} />{option.label}</label>)}</div></fieldset>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="settings-form-footer">{saved && <span className="success" role="status"><Check size={15} /> {t('设置已保存', 'Settings saved')}</span>}<button className="button primary" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}{t('保存设置', 'Save settings')}</button></div>
    </form>
    <form className="settings-card" onSubmit={changePassword}>
      <div className="settings-heading"><LockKeyhole size={20} /><div><h2>{t('修改密码', 'Change password')}</h2><p>{t('使用独立的长密码，建议交给密码管理器保存。', 'Use a unique, long password and keep it in a password manager.')}</p></div></div>
      <input type="text" name="username" autoComplete="username" value={user.username} hidden readOnly />
      <label>{t('当前密码', 'Current password')}<input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required /></label>
      <div className="two-columns"><label>{t('新密码', 'New password')}<input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={12} maxLength={72} /></label><label>{t('再次输入新密码', 'Confirm new password')}<input type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required minLength={12} maxLength={72} /></label></div>
      <small className="muted">{t('至少 12 个字符。修改后其他设备会退出登录，当前登录保留。', 'At least 12 characters. Other devices will be signed out; this session stays signed in.')}</small>
      {passwordError && <div className="error" role="alert">{passwordError}</div>}
      <div className="settings-form-footer"><button className="button secondary" disabled={passwordBusy}>{passwordBusy && <LoaderCircle size={15} className="spin" />}{t('更新密码', 'Update password')}</button></div>
    </form>
    <section className="settings-card">
      <div className="settings-heading"><DatabaseBackup size={20} /><div><h2>{t('备份与恢复', 'Backup and restore')}</h2><p>{t('笔记正文和附件一起保存，恢复前逐一核验。', 'Keep notes and attachments together, with every file checked before restore.')}</p></div></div>
      <div className="backup-description"><p>{t('备份通过随应用提供的本地工具完成。工具会短暂停止写入，保存数据库内容和私有附件，并生成校验清单。', 'Use the local backup tool included with the app. It briefly pauses writes, saves your data and private attachments, and creates a checksum manifest.')}</p><ol><li>{t('在运行应用的目录打开终端，按照 README 的“备份与恢复”执行备份命令。', 'Open a terminal in the app folder and run the backup command from the README’s backup and restore section.')}</li><li>{t('把备份保存在独立且安全的位置，定期实际恢复到空目标检查。', 'Keep backups in a separate, secure location. Regularly test a restore into an empty target.')}</li><li>{t('恢复仅接受空数据库，不覆盖已有笔记或附件。', 'Restores require an empty database and never overwrite existing notes or attachments.')}</li></ol><div className="notice"><FileKey2 size={17} /><span>{t('备份包含私人内容和账号信息，请像保管密码一样妥善保管。', 'Backups contain private content and account information. Protect them as carefully as your passwords.')}</span></div></div>
    </section>
    <section className="settings-card">
      <div className="settings-heading"><FileText size={20} /><div><h2>{t('附件清理', 'Attachment cleanup')}</h2><p>{t('删除笔记后会保留附件，避免误删草稿中仍在使用的文件。', 'Deleting a note keeps its attachments, since an unsaved draft may still need them.')}</p></div></div>
      <details onToggle={event => { if (event.currentTarget.open && looseAttachments === null) void loadAttachments(); }}><summary className="text-button">{t('查看未被已保存笔记引用的附件', 'View attachments not used in saved notes')}</summary><div className="attachment-cleanup"><p className="muted">{t('这些文件仍可能用于本机草稿。确认不再需要后再删除，删除无法撤销。', 'Local drafts may still use these files. Delete only files you no longer need. Deletion cannot be undone.')}</p>{attachmentError && <div className="error" role="alert">{attachmentError}</div>}{attachmentBusy && <span className="muted"><LoaderCircle size={15} className="spin" /> {t('正在处理…', 'Working…')}</span>}{looseAttachments?.map(attachment => <div className="cleanup-file" key={attachment.id}><FileText size={16} /><a href={attachment.url} target="_blank" rel="noopener noreferrer">{attachment.filename}<small>{formatSize(attachment.size)}</small></a><button className="icon-button danger" title={t(`删除 ${attachment.filename}`, `Delete ${attachment.filename}`)} aria-label={t(`删除 ${attachment.filename}`, `Delete ${attachment.filename}`)} disabled={attachmentBusy} onClick={() => void removeAttachment(attachment)}><Trash2 size={16} /></button></div>)}{looseAttachments?.length === 0 && <p className="muted">{t('没有需要清理的附件。', 'There are no attachments to clean up.')}</p>}<button className="button secondary small" disabled={attachmentBusy} onClick={() => void loadAttachments()}>{t('刷新列表', 'Refresh list')}</button></div></details>
    </section>
    <p className="settings-end">{t('Tutus · 个人轻笔记', 'Tutus · Personal notes')}<br /><span>{t('一个账号，一处安静的记录空间。', 'One account. A quiet space to write.')}</span></p>
  </div>;
}
