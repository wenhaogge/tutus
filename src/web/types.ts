export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}

export interface Note {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  version: number;
  attachments: Attachment[];
}

export type Theme = 'system' | 'light' | 'dark';
export interface Settings { displayName: string; theme: Theme }
export interface User { username: string; displayName: string; settings?: Partial<Settings> }
export interface AuthStatus { needsSetup: boolean; user: User | null }
export interface Stats { days: { day: string; count: number }[]; total: number; active: number; archived: number }
export type Page = 'timeline' | 'calendar' | 'archive' | 'settings';
