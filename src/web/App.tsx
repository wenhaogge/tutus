import CarrotIcon from './CarrotIcon';
import BrandLogo from './BrandLogo';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CalendarDays, CheckCircle2, ChevronRight, Hash, LoaderCircle, LogOut, Menu, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Sparkles, StickyNote, X } from 'lucide-react';
import { api, errorMessage } from './api';
import AuthGate from './AuthGate';
import Calendar from './Calendar';
import { LanguageSelect, useLanguage } from './i18n';
import NoteCard from './NoteCard';
import { draftPrefix } from './drafts';
import Settings from './Settings';
import type { AuthStatus, Note, Page, Settings as SettingsType, Stats } from './types';

const NoteEditor = lazy(() => import('./NoteEditor'));
function initialPage(): Page { const hash = window.location.hash.slice(1); return ['timeline', 'calendar', 'archive', 'settings'].includes(hash) ? hash as Page : 'timeline'; }

export default function App() {
  const { t, locale } = useLanguage();
  const editorLoading = <div className="editor-card editor-loading" role="status"><LoaderCircle size={17} className="spin" /> {t('正在准备编辑器…', 'Preparing the editor…')}</div>;
  const titles: Record<Page, { title: string; subtitle: string }> = {
    timeline: { title: t('我的笔记', 'My notes'), subtitle: t('给想法一个落脚的地方。', 'A little space for your thoughts.') },
    calendar: { title: t('记录日历', 'Calendar'), subtitle: t('回头看看，平凡日子也在发光。', 'Look back on the little things that made your days.') },
    archive: { title: t('已归档', 'Archive'), subtitle: t('暂时收好，随时可以找回来。', 'Set aside for now. Bring back whenever you like.') },
    settings: { title: t('设置', 'Settings'), subtitle: t('简单一点，用起来更自在。', 'Make this space feel like yours.') },
  };
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>(initialPage);
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showDates, setShowDates] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const request = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const user = auth?.user;
  const filtered = !!query || !!tag || !!from || !!to;
  const signature = `${page === 'archive'}|${query}|${tag}|${from}|${to}`;
  const currentSignature = useRef(signature);
  currentSignature.current = signature;

  const checkAuth = useCallback(() => {
    setAuthError('');
    api<AuthStatus>('/api/auth/status').then(setAuth).catch(err => setAuthError(errorMessage(err)));
  }, []);
  useEffect(checkAuth, [checkAuth]);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const expired = () => { setAuth(previous => previous ? { ...previous, user: null } : { needsSetup: false, user: null }); setNotice(t("登录已过期，请重新登录。本机未保存的草稿会保留。", "Your session expired. Sign in again; local drafts are still saved.")); setNotes([]); setTags([]); setStats(null); setEditing(null); };
    window.addEventListener('qingji:session-expired', expired);
    return () => window.removeEventListener('qingji:session-expired', expired);
  }, []);
  useEffect(() => { const onHash = () => setPage(initialPage()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { const value = user?.settings?.theme || 'system'; const next = value === 'dark' || value === 'system' && media.matches; setDark(next); document.documentElement.dataset.theme = next ? 'dark' : 'light'; };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [user?.settings?.theme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3800); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!user) return;
    let lastRefresh = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastRefresh < 5000) return;
      lastRefresh = Date.now();
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => setRevision(value => value + 1), 150);
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); clearTimeout(refreshTimer.current); };
  }, [user?.username]);

  const loadNotes = useCallback(async (append = false, offset = 0) => {
    if (!user || page === 'settings') return;
    const serial = ++request.current;
    const submittedSignature = currentSignature.current;
    setLoading(true); setError('');
    const params = new URLSearchParams({ archived: page === 'archive' ? '1' : '0', limit: '30', offset: String(offset) });
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);
    if (from) params.set('from', String(new Date(`${from}T00:00:00`).getTime()));
    if (to) { const end = new Date(`${to}T00:00:00`); end.setDate(end.getDate() + 1); params.set('to', String(end.getTime())); }
    try {
      const result = await api<{ notes: Note[]; total: number }>(`/api/notes?${params}`);
      if (serial !== request.current || submittedSignature !== currentSignature.current) return;
      setNotes(previous => append ? [...previous, ...result.notes.filter(note => !previous.some(existing => existing.id === note.id))] : result.notes); setTotal(result.total);
    } catch (err) { if (serial === request.current) setError(errorMessage(err)); } finally { if (serial === request.current) setLoading(false); }
  }, [user?.username, page, query, tag, from, to]);
  useEffect(() => { if (user) void loadNotes(); return () => { request.current++; }; }, [loadNotes, revision, user?.username]);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    Promise.all([api<{ tags: { name: string; count: number }[] }>('/api/tags'), api<Stats>(`/api/stats?tzOffset=${-new Date().getTimezoneOffset()}`)]).then(([tagData, statsData]) => { if (alive) { setTags(tagData.tags); setStats(statsData); } }).catch(err => { if (alive) setError(errorMessage(err)); });
    return () => { alive = false; };
  }, [user?.username, revision]);

  function navigate(next: Page) { setPage(next); window.location.hash = next; setSidebar(false); setEditing(null); setError(''); if (next !== 'calendar') { setFrom(''); setTo(''); } mainRef.current?.scrollTo({ top: 0 }); }
  function selectTag(value: string) { setTag(value); setPage('timeline'); window.location.hash = 'timeline'; setSidebar(false); setEditing(null); }
  function selectDay(value: string) { setFrom(value); setTo(value); setPage('calendar'); window.location.hash = 'calendar'; setSidebar(false); setShowDates(true); }
  function clearFilters() { setSearch(''); setQuery(''); setTag(''); setFrom(''); setTo(''); }
  function onSaved(_saved: Note) { setEditing(null); setToast(t('笔记已保存', 'Note saved')); setRevision(value => value + 1); }
  async function action(note: Note, kind: 'pin' | 'archive' | 'delete') {
    if (kind === 'delete') { setDeleteTarget(note); return; }
    setBusyNote(note.id); setError('');
    try { await api(`/api/notes/${note.id}`, { method: 'PATCH', body: JSON.stringify({ version: note.version, ...(kind === 'pin' ? { pinned: !note.pinned } : { archived: !note.archived }) }) }); setRevision(value => value + 1); setToast(kind === 'pin' ? note.pinned ? t("已取消置顶", "Note unpinned") : t("已置顶", "Note pinned") : note.archived ? t("笔记已恢复", "Note restored") : t("笔记已归档", "Note archived")); } catch (err) { setError(errorMessage(err)); } finally { setBusyNote(null); }
  }
  async function removeNote() {
    if (!deleteTarget) return;
    setBusyNote(deleteTarget.id); setError('');
    try { await api(`/api/notes/${deleteTarget.id}?version=${deleteTarget.version}`, { method: 'DELETE' }); try { localStorage.removeItem(`${draftPrefix(user!.username)}${deleteTarget.id}`); } catch { /* No draft storage available. */ } setDeleteTarget(null); setRevision(value => value + 1); setToast(t('笔记已删除', 'Note deleted')); } catch (err) { setError(errorMessage(err)); setDeleteTarget(null); } finally { setBusyNote(null); }
  }
  async function logout() {
    setLogoutBusy(true); setError('');
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); setAuth(previous => previous ? { ...previous, user: null } : null); setNotes([]); setTags([]); setStats(null); setEditing(null); setNotice(t("已安全退出。未发布的草稿保存在本机，同一账号登录后可继续。", "Signed out safely. Local drafts will be available when you sign in to the same account.")); setSidebar(false); } catch (err) { setError(errorMessage(err)); } finally { setLogoutBusy(false); }
  }
  function updateSettings(settings: SettingsType) { setAuth(previous => previous?.user ? { ...previous, user: { ...previous.user, displayName: settings.displayName, settings } } : previous); }

  if (!auth) return <div className="loading-screen"><BrandLogo /><h1>Tutus</h1>{authError ? <><p className="error">{authError}</p><button className="button secondary" onClick={checkAuth}>{t('重新连接', 'Reconnect')}</button></> : <p><LoaderCircle size={16} className="spin" /> {t('正在打开你的记录空间…', 'Opening your private space…')}</p>}</div>;
  if (!user) return <AuthGate setup={auth.needsSetup} notice={notice} onLogin={next => { setAuth({ needsSetup: false, user: next }); setNotice(''); setRevision(value => value + 1); }} />;

  const navigation = [{ key: 'timeline', icon: StickyNote, label: t("我的笔记", "My notes"), count: stats?.active }, { key: 'calendar', icon: CalendarDays, label: t("记录日历", "Calendar") }, { key: 'archive', icon: Archive, label: t("已归档", "Archive"), count: stats?.archived }, { key: 'settings', icon: Settings2, label: t("设置", "Settings") }] as const;
  return <div className="app-shell">
    {sidebar && <button className="sidebar-scrim" aria-label={t('关闭侧栏', 'Close sidebar')} onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? 'open' : ''}`}><a href="#timeline" className="brand" onClick={() => navigate('timeline')}><BrandLogo /><span>Tutus<span className="brand-caption">{t('记录，自在发生', 'Room for your thoughts')}</span></span></a>
      <button className="new-note-button" onClick={() => { navigate('timeline'); clearFilters(); setTimeout(() => document.querySelector<HTMLElement>('.cm-content')?.focus(), 80); }}><Plus size={18} /> {t('写点什么', 'New note')} <span>↵</span></button>
      <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}>{navigation.map(item => <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => navigate(item.key)}><item.icon size={18} /><span>{item.label}</span>{'count' in item && item.count !== undefined && <small>{item.count}</small>}</button>)}</nav>
      <div className="sidebar-divider" /><div className="sidebar-tags"><div className="section-label"><span>{t('我的标签', 'My tags')}</span><Hash size={14} /></div>{tags.length ? tags.map(item => <button key={item.name} className={tag === item.name ? 'active' : ''} onClick={() => selectTag(tag === item.name ? '' : item.name)}><Hash size={14} /><span>{item.name}</span><small>{item.count}</small></button>) : <p className="sidebar-empty">{t('在笔记里写下 #标签', 'Add #tags to your notes')}<br />{t('慢慢建立你的索引。', 'Build your own index.')}</p>}</div>
      <div className="sidebar-profile"><span className="profile-avatar">{(user.displayName || user.username).slice(0, 1)}</span><div><strong>{user.displayName || user.username}</strong><small>{t('我的私人空间', 'My private space')}</small></div><button className="icon-button" aria-label={t('退出登录', 'Sign out')} title={t('退出登录', 'Sign out')} disabled={logoutBusy} onClick={() => void logout()}>{logoutBusy ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}</button></div>
    </aside>
    <main className="main-area" ref={mainRef}>
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setSidebar(true)} aria-label={t('打开导航', 'Open navigation')}><Menu size={22} /></button><BrandLogo className="breadcrumb-logo desktop-leaf" /><span>{t('私人空间', 'Private space')}</span><ChevronRight size={13} /><strong>{titles[page].title}</strong></div><div className="topbar-right"><LanguageSelect className="compact" /><span className="private-badge"><span /> {t('仅自己可见', 'Only you')}</span><button className="icon-button" onClick={() => setRevision(value => value + 1)} aria-label={t('刷新笔记', 'Refresh notes')} title={t('刷新笔记', 'Refresh notes')}><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div></header>
      <div className="content"><div className="page-heading"><div><span className="eyebrow">{page === 'timeline' ? new Date().toLocaleDateString(locale, { month: 'long', day: 'numeric', weekday: 'long' }) : t("你的私人记录空间", "Your private space")}</span><h1>{titles[page].title}<span className="heading-dot">.</span></h1><p>{titles[page].subtitle}</p></div>{page === 'timeline' && <div className="heading-carrot"><CarrotIcon /></div>}</div>
        {page === 'settings' ? <>{error && <div className="error page-error" role="alert">{error}</div>}<Settings user={user} onUpdate={updateSettings} onPasswordChanged={() => setToast(t('密码已更新，其他设备已退出登录', 'Password updated. Other devices have been signed out.'))} /></> : <>
          {page === 'timeline' && <Suspense fallback={editorLoading}><NoteEditor username={user.username} onSaved={onSaved} dark={dark} /></Suspense>}
          {page === 'calendar' && <Calendar stats={stats} onDay={selectDay} selected={from === to ? from : ''} />}
          <div className="filter-bar"><div className="search-box"><Search size={17} /><input aria-label={t('搜索笔记', 'Search notes')} placeholder={t('搜索你的笔记…', 'Search your notes…')} value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="icon-button small" onClick={() => setSearch('')} aria-label={t('清除搜索', 'Clear search')}><X size={14} /></button>}</div><button className={`button filter-button ${showDates || from || to ? 'active' : ''}`} onClick={() => setShowDates(!showDates)}><SlidersHorizontal size={16} /><span>{t('筛选', 'Filters')}</span></button></div>
          {showDates && <div className="date-filters"><label>{t('开始日期', 'Start date')}<input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label><span>{t('至', 'to')}</span><label>{t('结束日期', 'End date')}<input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label><button className="button subtle small" onClick={() => { setFrom(''); setTo(''); }}>{t('清除日期', 'Clear dates')}</button></div>}
          <div className="timeline-label"><div><span>{page === 'archive' ? t("归档记录", "Archived notes") : filtered ? t("筛选结果", "Search results") : t("最近记录", "Recent notes")}</span><small>{t(`${total} 条`, `${total} ${total === 1 ? 'note' : 'notes'}`)}</small>{tag && <button className="tag selected" onClick={() => setTag('')}>#{tag}<X size={12} /></button>}</div>{filtered && <button className="text-button" onClick={clearFilters}>{t('清除筛选', 'Clear filters')}</button>}</div>
          {error && <div className="error page-error" role="alert">{error}<button className="text-button" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button></div>}
          <div className="notes-list" aria-busy={loading}>{notes.map(note => editing === note.id ? <Suspense key={note.id} fallback={editorLoading}><NoteEditor username={user.username} note={note} onSaved={onSaved} onCancel={() => setEditing(null)} dark={dark} /></Suspense> : <NoteCard key={note.id} note={note} busy={busyNote === note.id} onEdit={() => setEditing(note.id)} onAction={(item, kind) => void action(item, kind)} onTag={selectTag} />)}</div>
          {loading && <div className="list-loading"><LoaderCircle size={19} className="spin" /><span>{t('正在加载…', 'Loading…')}</span></div>}
          {!loading && !notes.length && !error && <div className="empty-state"><span className="empty-icon">{filtered ? <Search size={29} /> : page === 'archive' ? <Archive size={29} /> : <Sparkles size={29} />}</span><h2>{filtered ? t("还没有找到这条记录", "No matching notes") : page === 'archive' ? t("这里暂时空着", "Nothing here yet") : t("第一条记录，从此刻开始", "Your first note starts here")}</h2><p>{filtered ? t("换个关键词，或放宽日期和标签条件试试。", "Try another keyword or adjust your date and tag filters.") : page === 'archive' ? t("归档的笔记会保存在这里，随时可以恢复。", "Archived notes stay here until you want to bring them back.") : t("今天的小发现、脑海中的念头，都值得被记下来。", "A small discovery, a passing thought—give it a place to stay.")}</p>{filtered && <button className="button secondary" onClick={clearFilters}>{t('查看全部笔记', 'View all notes')}</button>}</div>}
          {!loading && notes.length > 0 && notes.length < total && <button className="button secondary load-more" onClick={() => void loadNotes(true, notes.length)}>{t('加载更多', 'Load more')}</button>}
          {!loading && notes.length > 0 && notes.length >= total && <div className="timeline-end"><span /> {t('记录让日常有迹可循', 'Little notes, lasting memories')} <span /></div>}
        </>}
        <footer className="app-footer"><BrandLogo className="footer-logo" /> Tutus <span>·</span> {t('留一点空间，给自己的想法', 'A little space for your thoughts')}</footer>
      </div>
    </main>
    <nav className="mobile-bottom-nav" aria-label={t('手机导航', 'Mobile navigation')}>{navigation.map(item => <button key={item.key} className={page === item.key ? 'active' : ''} onClick={() => navigate(item.key)}><item.icon size={20} /><span>{item.label}</span></button>)}</nav>
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}<button className="icon-button small" aria-label={t('关闭提示', 'Dismiss notification')} onClick={() => setToast('')}><X size={14} /></button></div>}
    {deleteTarget && <div className="dialog-backdrop"><section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="dialog-icon"><Archive size={23} /></span><h2 id="delete-title">{t('永久删除这条笔记？', 'Permanently delete this note?')}</h2><p>{t('这一步无法撤销。如果只是暂时不想看到它，可以选择归档。', 'This cannot be undone. You can archive the note if you just want to set it aside.')}</p><div className="delete-preview">{deleteTarget.content.slice(0, 140) || t("含附件的笔记", "Note with attachments")}</div><div className="dialog-actions"><button className="button secondary" disabled={!!busyNote} onClick={() => setDeleteTarget(null)} autoFocus>{t('保留笔记', 'Keep note')}</button><button className="button destructive" disabled={!!busyNote} onClick={() => void removeNote()}>{busyNote && <LoaderCircle size={15} className="spin" />}{t('永久删除', 'Delete permanently')}</button></div></section></div>}
  </div>;
}
