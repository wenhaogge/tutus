export interface Bindings {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  SETUP_SECRET: string;
}

export interface Variables {
  sessionHash: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export interface OwnerRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  settings_json: string;
  created_at: number;
  updated_at: number;
}
