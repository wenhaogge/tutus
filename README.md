# Tutus

给自己用的轻笔记。打开就能写，按时间翻阅，用标签和搜索找回记录。

Tutus 运行在 Cloudflare Workers 上，D1 保存笔记，私有 R2 保存图片和附件。网页与 API 由同一个 Worker 提供。

## 功能

- 单账号登录、退出和改密，建立账号后关闭注册。
- Markdown 编辑、标签、关键词搜索、日期筛选和日历。
- 笔记置顶、归档、恢复和删除。
- 图片与文件附件，单文件上限 10 MiB。
- 24 小时只读分享，过期后可以重新生成链接。
- 中文和英文界面、深浅主题、手机布局。
- 本机草稿保护，以及带文件校验的备份与恢复工具。

笔记默认私有。只有主动分享的笔记及其关联附件能通过分享链接访问，R2 不开放公共读取。分享页展示笔记的最新内容，编辑会同步反映在分享页；删除笔记后链接失效。

## 本地运行

需要 Node.js 22 或以上，以及 pnpm 11。

```sh
git clone https://github.com/wenhaogge/tutus.git
cd tutus
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:8787/>。首次进入时，从 `.local/setup-secret.txt` 复制建号密钥，再设置自己的用户名和密码。Windows 安装好依赖后，也可以双击 `START.cmd` 启动。

数据库、附件和建号密钥保存在 `.local/`，重启不会清空。不要删除这个目录。它和备份、环境变量文件都已被排除在 Git 之外。

修改代码后重新运行 `pnpm dev`。需要换端口时设置 `PORT` 环境变量。

## 部署到 Cloudflare

仓库中的 `wrangler.jsonc` 是脱敏模板。先新建 D1 和私有 R2，再将模板复制为 `wrangler.local.jsonc`，把实际资源标识填入这份本地配置。该文件不会提交到 Git。下面的初始化步骤仅用于新实例。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec wrangler login
pnpm exec wrangler d1 create tutus
pnpm exec wrangler r2 bucket create tutus-files
```

将新建 D1 的 `database_id` 和 R2 的 `bucket_name` 填入 `wrangler.local.jsonc`。如果资源名称不同，也要更新 `database_name`。保留绑定名称 `DB`、`FILES` 和 `ASSETS`。

仅对新建的空数据库执行初始化：

```sh
pnpm exec wrangler d1 execute tutus --remote --file schema.sql --config wrangler.local.jsonc
pnpm exec wrangler secret put SETUP_SECRET --config wrangler.local.jsonc
pnpm exec wrangler deploy --config wrangler.local.jsonc
```

`SETUP_SECRET` 使用密码管理器生成至少 32 个字符的随机值，通过命令提示输入，不要写进配置文件或提交到仓库。部署后打开 Worker 地址，使用这个密钥建立唯一账号。

R2 保持私有，不开启 `r2.dev` 或公共自定义域名。附件由 Worker 校验登录或分享链接后读取。配置中的定时任务用于清理过期会话和上传残留，不会自动备份。

后续更新代码后重新构建、部署即可，不需要再次初始化数据库。有数据库变更时，先备份，再按对应迁移更新。已有早期版本若缺少分享表，使用 `migrations/0002_shares.sql`；全新数据库的 `schema.sql` 已包含该表。

后续在本机更新时，运行 `pnpm build`，再运行 `pnpm exec wrangler deploy --config wrangler.local.jsonc`。本地配置要单独保管。若改用 Cloudflare Git 构建集成，需要先在构建环境准备实际绑定配置，不能直接使用仓库里的占位符部署。

### 部署前需要知道

目前已通过本地 Workerd、D1 和 R2 测试，尚未完成真实 Cloudflare 环境验证。密码使用 bcrypt cost 12，本机单次计算约 250 ms，是否能在 Workers 免费 CPU 限额内完成登录仍需实测。部署配置不会自动开通付费服务。

正式存放数据前，检查登录、未登录访问拒绝、私有附件读取、重新部署后数据是否完整，并将备份恢复到另一套空实例，实际打开笔记和图片。

## 备份与恢复

在应用运行时执行以下命令。工具会询问用户名和密码；密码输入不会显示。云端地址必须使用 HTTPS。

```sh
# 导出到一个尚不存在的目录
node scripts/backup.mjs export --url http://127.0.0.1:8787 --out ./backups/2026-10-07

# 校验备份
node scripts/backup.mjs verify --from ./backups/2026-10-07

# 恢复到已建立账号、没有笔记或附件的空实例
node scripts/backup.mjs restore --url https://YOUR-WORKER.workers.dev --from ./backups/2026-10-07
```

备份包含笔记、标签、时间、置顶与归档状态、基本设置和原始附件。它不包含账号密码、会话、建号密钥或分享链接。恢复后保留目标账号的密码，已有会话会退出，笔记默认私有。

工具逐个校验文件的 SHA-256。导出目录没有 `COMPLETE` 标记时，不能视为完整备份。备份是明文数据，应放在受保护的磁盘上，并另存一份独立副本。

备份期间暂时停止内容修改。如果进程意外中断，先查看状态，再按需解除维护状态：

```sh
node scripts/backup.mjs status --url http://127.0.0.1:8787
node scripts/backup.mjs release --url http://127.0.0.1:8787
```

当前备份上限为 10,000 条笔记、2,000 个附件、20,000 条附件关联、8 MiB 元数据，每个附件仍不超过 10 MiB。超过上限会报错；这些上限尚未经过云端大规模压测。

## 开发

```sh
pnpm check
pnpm build
pnpm test
```

自动测试使用隔离的本地 Workerd、D1 和 R2，覆盖鉴权、笔记、附件、分享过期、异常恢复、备份恢复和进程重启后的持久化，不使用 `.local/` 中的数据。

浏览器测试使用 `http://localhost:8788/`，日常本机应用使用 `http://127.0.0.1:8787/`，避免同一主机的不同端口共用登录 Cookie。

```text
src/web/       React 界面
src/worker/    Hono API、认证、文件与备份
public/        图标和静态资源响应头
scripts/       本地启动、构建、备份工具
tests/         自动测试
migrations/    数据库增量迁移
schema.sql     新数据库结构
wrangler.jsonc Worker 部署配置
```

前端使用 React、CodeMirror 和 react-markdown，后端使用 Hono，密码处理使用 bcryptjs。依赖版本记录在 `pnpm-lock.yaml`。
