import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import SharePage from './SharePage';
import { useLanguage } from './i18n';
import './styles.css';

function FatalError() {
  const { t } = useLanguage();
  return <main className="fatal"><h1>{t('页面暂时没有准备好', 'This page could not be loaded')}</h1><p>{t('请刷新后重试，已保存在本机的草稿会保留。', 'Reload to try again. Drafts saved on this device will be kept.')}</p><button className="button primary" onClick={() => window.location.reload()}>{t('重新加载', 'Reload')}</button></main>;
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <FatalError />;
    return this.props.children;
  }
}

const publicShare = window.location.pathname === '/s' || window.location.pathname.startsWith('/s/');
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary>{publicShare ? <SharePage /> : <App />}</ErrorBoundary></React.StrictMode>);
