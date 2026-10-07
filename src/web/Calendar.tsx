import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { dayKey } from './api';
import type { Stats } from './types';
import { useLanguage } from './i18n';

export default function Calendar({ stats, onDay, selected }: { stats: Stats | null; onDay: (day: string) => void; selected: string }) {
  const { t, locale } = useLanguage();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const counts = new Map(stats?.days.map(day => [day.day, day.count]) || []);
  const cells = [];
  const offset = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let index = 0; index < Math.ceil((offset + days) / 7) * 7; index++) {
    const date = new Date(month.getFullYear(), month.getMonth(), index - offset + 1);
    const key = dayKey(date); const count = counts.get(key) || 0;
    const outside = date.getMonth() !== month.getMonth();
    cells.push(<button type="button" key={key} className={`calendar-day ${outside ? 'outside' : ''} ${selected === key ? 'selected' : ''} ${key === dayKey(new Date()) ? 'today' : ''}`} onClick={() => onDay(key)} aria-label={t(`${key}，${count} 条笔记`, `${date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })}, ${count} ${count === 1 ? 'note' : 'notes'}`)} aria-pressed={selected === key}><span>{date.getDate()}</span>{count > 0 ? <small>{t(`${count} 条`, `${count} ${count === 1 ? 'note' : 'notes'}`)}</small> : <i />}</button>);
  }
  function move(by: number) { setMonth(previous => new Date(previous.getFullYear(), previous.getMonth() + by, 1)); }
  return <section className="calendar-card"><div className="calendar-title"><div><span className="eyebrow">{t('记录的足迹', 'Your days in notes')}</span><h2>{t(`${month.getFullYear()} 年 ${month.getMonth() + 1} 月`, month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }))}</h2></div><div><button className="icon-button" aria-label={t('上个月', 'Previous month')} onClick={() => move(-1)}><ChevronLeft size={18} /></button><button className="button subtle small" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('今天', 'Today')}</button><button className="icon-button" aria-label={t('下个月', 'Next month')} onClick={() => move(1)}><ChevronRight size={18} /></button></div></div><div className="calendar-grid">{['一', '二', '三', '四', '五', '六', '日'].map((day, index) => <div className="weekday" key={day}>{t(day, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][index])}</div>)}{cells}</div><p className="calendar-hint">{t('选择一天，翻阅当时留下的记录。日期按当前设备时区显示。', 'Choose a day to revisit your notes. Dates use your device’s time zone.')}</p></section>;
}
