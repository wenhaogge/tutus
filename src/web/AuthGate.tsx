import CarrotIcon from './CarrotIcon';
import BrandLogo from './BrandLogo';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, LoaderCircle, LockKeyhole } from 'lucide-react';
import { api, errorMessage } from './api';
import { LanguageSelect, useLanguage } from './i18n';
import type { User } from './types';

export default function AuthGate({ setup, notice, onLogin }: { setup: boolean; notice: string; onLogin: (user: User) => void }) {
  const { t } = useLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (setup && new TextEncoder().encode(password).byteLength > 72) { setError(t('密码不能超过 72 字节；中文字符通常占 3 字节。', 'Passwords must be 72 bytes or fewer. Chinese characters usually use 3 bytes each.')); return; }
    setBusy(true); setError('');
    try {
      const { user } = await api<{ user: User }>(`/api/auth/${setup ? 'setup' : 'login'}`, { method: 'POST', body: JSON.stringify(setup ? { setupSecret: secret, username, password, displayName: displayName.trim() || username } : { username, password }) });
      setPassword(''); setSecret(''); onLogin(user);
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <section className="auth-story">
      <div className="brand"><BrandLogo /><span>Tutus<span className="brand-caption">{t('个人轻笔记', 'PERSONAL NOTES')}</span></span></div>
      <div className="auth-story-text"><span className="eyebrow">A LITTLE SPACE FOR YOUR THOUGHTS</span><h1>{t('把生活里的灵光，', 'A little thought,')}<br />{t('轻轻记下来。', 'a lasting note.')}</h1><p>{t('一个想法，一段日常，一张照片。', 'An idea, a moment, a photograph.')}<br />{t('属于你自己的安静角落。', 'A quiet corner of your own.')}</p><div className="auth-demo"><span className="demo-date">{t('今天 · 此刻', 'Today · Right now')}</span><p>{t('不用等想清楚了才开始记录。', 'You don’t need every thought figured out.')}<br />{t('写下来，思路就有了生长的地方。', 'Write it down and give it room to grow.')} <CarrotIcon className="inline-carrot" /></p><span className="tag">{t('#日常', '#everyday')}</span><span className="tag">{t('#小想法', '#ideas')}</span></div></div>
      <p className="auth-foot"><LockKeyhole size={14} /> {t('私人笔记 · 由你保管', 'Private notes · Yours to keep')}</p>
    </section>
    <main className="auth-form-panel"><LanguageSelect className="auth-language" /><form className="auth-form" onSubmit={submit}>
      <div className="mobile-brand"><BrandLogo /> Tutus</div>
      <span className="eyebrow">{setup ? t('从这里开始', 'START HERE') : t('欢迎回来', 'WELCOME BACK')}</span>
      <h2>{setup ? t('建立你的私人空间', 'Make a space of your own') : t('登录Tutus', 'Sign in to Tutus')}</h2><p className="muted">{setup ? t('只建立一个账号，完成后会自动关闭注册。', 'Create your one personal account. Registration closes automatically afterward.') : t('继续记录，继续发现生活里值得留下的事。', 'Keep writing. Keep noticing the things worth remembering.')}</p>
      {notice && <div className="notice" role="status">{notice}</div>}
      {setup && <label>{t('一次性建号密钥', 'One-time setup secret')}<input autoComplete="off" type="password" value={secret} onChange={e => setSecret(e.target.value)} required /><small>{t('使用部署时设置的 SETUP_SECRET。', 'Use the SETUP_SECRET configured for this app.')}</small></label>}
      <label>{t('用户名', 'Username')}<input autoComplete="username" name="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={setup ? 3 : undefined} maxLength={32} autoCapitalize="none" spellCheck={false} />{setup && <small>{t('3–32 个字符，可用中文、字母、数字和 _ . -。', '3–32 characters: Chinese characters, letters, numbers, and _ . - are allowed.')}</small>}</label>
      {setup && <label>{t('你的称呼', 'Display name')}<input autoComplete="nickname" value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={80} placeholder={t('怎么称呼你？', 'What should we call you?')} /></label>}
      <label>{t('密码', 'Password')}<input autoComplete={setup ? 'new-password' : 'current-password'} name="password" type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={setup ? 12 : undefined} maxLength={72} />{setup && <small>{t('至少 12 个字符，建议使用密码管理器生成独立密码。', 'At least 12 characters. Use a password manager to generate a unique password.')}</small>}</label>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="button primary auth-submit" disabled={busy} type="submit">{busy ? <LoaderCircle size={17} className="spin" /> : setup ? <Check size={17} /> : <ArrowRight size={17} />}{busy ? t('正在验证…', 'Verifying…') : setup ? t('建立账号并进入', 'Create account') : t('登录', 'Sign in')}</button>
      <p className="privacy-note"><LockKeyhole size={13} /> {t('登录后才能访问笔记和附件。', 'Sign in to access your notes and attachments.')}</p>
    </form></main>
  </div>;
}
