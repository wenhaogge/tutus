import { translate } from './i18n';

// Keep protocol codes stable and translate only at the UI boundary. Exact messages
// disambiguate shared codes (notably password validation vs. a wrong current password).
const messageEnglish: Record<string, string> = {
  '请先初始化账号。': 'Set up your account first.',
  '当前密码不正确。': 'Your current password is incorrect.',
  '账号状态已变化，请重新登录后重试。': 'Your account has changed. Sign in again and retry.',
  '笔记不存在。': 'This note no longer exists.',
  '附件不存在。': 'This attachment no longer exists.',
  '不支持此接口。': 'This operation is not supported.',
  '附件地址无效。': 'This attachment address is invalid.',
  '这次保存的编号已使用，请先确认原笔记是否保存成功。': 'This save ID is already in use. Check whether your original note was saved before trying again.',
  '重复请求的附件列表不同。': 'The attachment list differs from the original save. Check the saved note before retrying.',
  '笔记已变化，请重新加载后删除。': 'This note has changed. Reload it before deleting.',
  '删除未完成，请重试。': 'The note was not deleted. Please retry.',
  '无效的记录编号。': 'The record ID is invalid.',
  '数字或日期范围无效。': 'The number or date range is invalid.',
  '笔记不能为空，且不能超过 100 KB。': 'A note cannot be empty or exceed 100 KB.',
  '附件列表无效或超过 40 个。': 'The attachment list is invalid or contains more than 40 files.',
  '每篇笔记最多关联 40 个附件。': 'Each note can contain up to 40 attachments.',
  '附件尚未上传完成或已删除，请重新上传。': 'An attachment has not finished uploading or was deleted. Upload it again.',
  '搜索词或标签过长。': 'The search term or tag is too long.',
  '归档条件无效。': 'The archive filter is invalid.',
  '结束日期早于开始日期。': 'The end date must not be before the start date.',
  '编辑需要笔记版本。': 'Reload the note before editing; its version is missing or invalid.',
  '归档与置顶必须是布尔值。': 'The archive and pin values must be true or false.',
  '删除需要版本。': 'Reload the note before deleting; its version is missing.',
  '日期范围无效。': 'The date range is invalid.',
  '文件内容为空。': 'The file body is missing.',
  '文件名无效。': 'The filename is invalid.',
  '文件名为空、过长或包含路径。': 'The filename is empty, too long, or contains a path.',
  '文件类型无效。': 'The file type is invalid.',
  '只支持查询未引用的附件。': 'Only unattached files can be listed here.',
  '昵称须为 1–80 个字符。': 'Your display name must contain 1–80 characters.',
  '主题选项无效。': 'The theme option is invalid.',
  '备份包含未知字段': 'The backup contains unsupported fields.',
  '备份格式错误': 'The backup format is invalid.',
  '不支持的备份版本': 'This backup version is not supported.',
  '备份必须包含一份账号资料': 'The backup must contain exactly one account profile.',
  '账号资料无效': 'The account profile in the backup is invalid.',
  '设置无效': 'The settings in the backup are invalid.',
  '主题设置无效': 'The backup theme setting is invalid.',
  '设置 JSON 或主题无效': 'The backup settings JSON or theme is invalid.',
  '笔记 ID 无效或重复': 'A note ID in the backup is invalid or duplicated.',
  '笔记内容无效': 'A note in the backup has invalid content.',
  '标签 JSON 无效': 'The backup tags JSON is invalid.',
  '标签无效': 'The backup tags are invalid.',
  '笔记状态无效': 'A note in the backup has an invalid state.',
  '附件 ID 无效或重复': 'An attachment ID in the backup is invalid or duplicated.',
  '附件元数据无效': 'The backup attachment metadata is invalid.',
  '附件关联指向不存在的数据': 'A backup attachment link refers to missing data.',
  '附件关联重复': 'The backup contains duplicate attachment links.',
  '备份元数据超过 8 MiB 容量上限': 'The backup metadata exceeds the 8 MiB limit.',
  '请求超过容量上限': 'The request exceeds the size limit.',
  'JSON 请求无效': 'The request JSON is invalid.',
  '备份凭据无效': 'The backup credentials are invalid.',
  '备份锁已失效，请检查维护状态': 'The backup lock is no longer valid. Check maintenance status.',
  '恢复清单丢失，请释放维护状态后重试': 'The restore manifest is missing. Release maintenance mode before retrying.',
  '正在维护或附件操作尚未完成，请稍后重试': 'Maintenance or an attachment operation is still in progress. Please retry later.',
  '数据超过单次备份容量（8 MiB 元数据、10000 条笔记、2000 个附件）': 'The data exceeds the backup limit: 8 MiB of metadata, 10,000 notes, and 2,000 attachments.',
  '维护状态或登录会话已变化': 'Maintenance status or your sign-in session has changed. Check the current status.',
  '只允许恢复到已建号、没有笔记和附件、未维护的空应用': 'Restore requires an initialized account with no notes or attachments and no active maintenance operation.',
  '该附件不在恢复清单中': 'This attachment is not in the restore manifest.',
  '附件校验失败，未写入': 'Attachment verification failed. The file was not written.',
  '还有附件未上传或校验不匹配，恢复未提交': 'Some attachments are missing or failed verification. The restore has not been committed.',
  '备份超过单次原子恢复容量，尚未提交': 'The backup exceeds the atomic restore limit. The restore has not been committed.',
  '维护凭据已变化，请重新读取状态': 'The maintenance credentials have changed. Read the status again.',
  '维护状态已变化': 'Maintenance status has changed. Read the status again.',
};

const codeEnglish: Record<string, string> = {
  NETWORK_ERROR: 'The connection failed. Check your network and retry. Your unsaved draft is still available.',
  ORIGIN_REJECTED: 'This request came from an untrusted origin. Reopen the app and retry.',
  HTTPS_REQUIRED: 'Open the app using HTTPS.',
  JSON_REQUIRED: 'The request must use JSON.',
  BODY_TOO_LARGE: 'The request is too large.',
  INVALID_JSON: 'The request JSON is invalid.',
  INVALID_BODY: 'The request body must be an object.',
  UNKNOWN_FIELD: 'The request contains an unsupported field.',
  INVALID_FIELD: 'A required field is empty or too long.',
  INVALID_ARGUMENT: 'The request contains an invalid value. Check your input and retry.',
  INVALID_PASSWORD: 'Use a long, unique password with at least 12 characters and no more than 72 UTF-8 bytes.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  MAINTENANCE: 'A backup or restore is in progress. Please retry later. Your draft is safe.',
  RATE_LIMITED: 'Too many attempts. Please retry in 15 minutes.',
  ALREADY_SETUP: 'An account already exists. Public registration is closed.',
  SETUP_UNAVAILABLE: 'Configure a random setup secret of at least 32 characters first.',
  INVALID_SETUP_SECRET: 'The setup secret is incorrect.',
  INVALID_USERNAME: 'Use 3–32 letters, numbers, underscores, periods, or hyphens for your username.',
  NEEDS_SETUP: 'Set up your account first.',
  INVALID_CREDENTIALS: 'The username or password is incorrect.',
  CREDENTIALS_CHANGED: 'Your password has just changed. Please sign in again.',
  VERSION_CONFLICT: 'This note was edited elsewhere. Keep your draft and reload the note.',
  STATE_CHANGED: 'Your session, an attachment, or maintenance status has changed. Reload and retry. Your draft is safe.',
  ID_CONFLICT: 'This save conflicts with an earlier request. Keep your draft and check the saved note.',
  FILE_TOO_LARGE: 'Files must not exceed 10 MiB.',
  UPLOAD_CONFLICT: 'This upload ID belongs to a different file. Select the file again.',
  UPLOAD_DELETING: 'This file is being deleted. Select the file again.',
  UPLOAD_INTERRUPTED: 'The upload state has changed. Please retry.',
  UPLOAD_IN_PROGRESS: 'This file is still uploading and cannot be deleted yet.',
  FILE_IN_USE: 'This attachment is used by a note and cannot be deleted.',
  FILE_MISSING: 'This attachment is temporarily unavailable. Check your backup or retry.',
  NOT_FOUND: 'The requested item was not found.',
  BACKUP_ERROR: 'The backup operation could not be completed. Check maintenance status before retrying.',
  BACKUP_FAILED: 'The backup operation failed. Existing data was not overwritten. Check maintenance status before retrying.',
  INTERNAL_ERROR: 'The operation could not be completed. Please retry later. Your unsaved draft is still available.',
};

function localizedApiMessage(message: string, status: number, code: string): string {
  let english = messageEnglish[message];
  const field = /^(用户名|显示名称)不能为空，且不能超过 (\d+) 个字符。$/.exec(message);
  if (field) english = `${field[1] === '用户名' ? 'Username' : 'Display name'} is required and must not exceed ${field[2]} characters.`;
  const backupTable = /^(账号资料|笔记|附件|附件关联) 格式错误或超过恢复容量$/.exec(message);
  if (backupTable) {
    const names: Record<string, string> = { '账号资料': 'Account profile', '笔记': 'Notes', '附件': 'Attachments', '附件关联': 'Attachment links' };
    english = `${names[backupTable[1]]} in the backup have an invalid format or exceed the restore limit.`;
  }
  english ||= codeEnglish[code];
  english ||= status === 401 ? 'Please sign in to continue.'
    : status === 403 ? 'This operation is not permitted. Reopen the app and retry.'
    : status === 413 ? 'The request exceeds the size limit.'
    : status === 429 ? 'Too many requests. Please retry later.'
    : status === 409 ? 'The data has changed. Keep your draft, reload, and retry.'
    : `The request could not be completed (${status}). Please retry later. Your unsaved draft is still available.`;
  // Unknown server messages also receive an English fallback, never raw Chinese.
  return translate(message, english);
}

export class ApiError extends Error {
  constructor(public originalMessage: string, public status: number, public code: string) {
    super(localizedApiMessage(originalMessage, status, code));
    this.name = 'ApiError';
  }
}

export async function api<T = void>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试。未保存的内容仍保留在草稿中。', 0, 'NETWORK_ERROR');
  }
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('qingji:session-expired'));
    }
    throw new ApiError(typeof data?.error?.message === 'string' ? data.error.message : `请求未完成（${response.status}），请稍后重试。`, response.status, typeof data?.error?.code === 'string' ? data.error.code : 'HTTP_ERROR');
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return localizedApiMessage(error.originalMessage, error.status, error.code);
  return error instanceof Error ? error.message : translate('操作未完成，请重试。', 'The operation could not be completed. Please retry.');
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function isInlineImage(mime: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime.toLowerCase());
}

export function dayKey(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
