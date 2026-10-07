import { useSyncExternalStore } from 'react';
import { Languages } from 'lucide-react';

export type Language = 'zh-CN' | 'en';
const storageKey = 'qingji:language';
function readLanguage(): Language {
  try { return localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}
let language = readLanguage();
const listeners = new Set<() => void>();
function updateDocument() {
  document.documentElement.lang = language;
  document.title = translate('Tutus · 留住日常的灵光', 'Tutus · A little space for your thoughts');
}
export function translate(zh: string, en: string): string { return language === 'en' ? en : zh; }
function publish(next: Language) {
  language = next;
  updateDocument();
  listeners.forEach(listener => listener());
}
export function setLanguage(next: Language) {
  try { localStorage.setItem(storageKey, next); } catch { /* Still switch for this session when storage is unavailable. */ }
  publish(next);
}
function onStorage(event: StorageEvent) { if (event.key === storageKey || event.key === null) publish(readLanguage()); }
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', onStorage); };
}
updateDocument();
export function useLanguage() {
  const current = useSyncExternalStore(subscribe, () => language);
  return { language: current, locale: current === 'en' ? 'en-US' : 'zh-CN', setLanguage, t: translate };
}
export function LanguageSelect({ className = '' }: { className?: string }) {
  const { language: current, setLanguage: change, t } = useLanguage();
  return <label className={`language-select ${className}`}><Languages size={15} aria-hidden="true" /><span>{t('语言', 'Language')}</span><select value={current} aria-label={t('界面语言', 'Interface language')} onChange={event => change(event.target.value as Language)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></label>;
}
