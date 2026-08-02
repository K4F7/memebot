# MemeBot

面向 QQ 社团运营场景的 Koishi 插件集合。仓库只包含下面四个插件；每个
`plugins/memebot-*` 都可以独立安装、配置、构建和发布，不依赖其他 MemeBot
插件。

## 插件与端到端流程

| 插件 | 配置 | 用户动作 | 系统处理 | 管理员动作 | 可观察结果 |
| --- | --- | --- | --- | --- | --- |
| `koishi-plugin-memebot-intake` | 为投稿、反馈、建议分别配置 QQ 通知目标和附件目录 | 在 QQ 中开始收集并连续发送文字或附件 | 保存 Intake Draft，提交后生成稳定编号并投递管理通知；失败通知自动重试 | 引用管理通知认领、转交、变更状态、关闭或重开 | 用户获得 `投稿#N`、`反馈#N` 或 `建议#N`，并可查询自己的记录 |
| `koishi-plugin-memebot-faq` | 配置管理员、管理群和公开列表页大小 | 在 QQ 中分页浏览或按 `#N` 查询 | 只向普通成员展示公开条目 | 新增、编辑、隐藏、重新公开；已隐藏条目才可永久删除 | 用户看到稳定的 FAQ 编号、问题和答案 |
| `koishi-plugin-memebot-activity` | 配置管理员、管理群以及 QQ 用户/群通知目标 | 在 QQ 中查看近期活动或按 `#N` 查询 | 根据开始、结束时间计算近期与历史状态 | 引导新增、编辑、取消，并选择仅保存或同时通知 | 用户看到活动时间、状态、地点、描述和链接；被选中的 QQ 目标收到通知 |
| `koishi-plugin-memebot-archive` | 配置本地目录、PDF/ZIP 上限及可选 R2；同时提供 Database 和 Console | 在 QQ 中搜索或按 `P<N>`、`W<N>` 获取归档 | 元数据写入 Koishi Database，附件本地优先保存，R2 作为可重试备份 | QQ 命令用于常用快捷操作；Archive WebUI 完成发布、预览、关联、恢复和生命周期管理 | 用户获得 Paper PDF 或 Work ZIP；管理员可观察预检、备份、恢复和审计状态 |

四个插件的管理员身份规则相同：显式配置的 QQ 用户，或 Koishi authority 不低于
4。`managementGroups` 只限制群聊管理动作可以发生的位置，不会把群成员自动变成
管理员；私聊管理动作仍要求管理员身份。插件只按 QQ 用户和 QQ 群路由，不提供其他
平台的兼容路由，也不提供可配置的 authority 阈值。

## Intake

主要配置：

- `targets.submission`、`targets.feedback`、`targets.suggestion`：每类 Intake 的
  `users` 和 `groups` QQ 通知目标；没有目标的类型不能开始收集。
- `administrators`、`managementGroups`：管理员身份与管理群位置。
- `attachmentPath`：附件本地目录，默认 `data/memebot-intake`。

成员在 QQ 中使用 `/submit`、`/feedback` 或 `/suggest` 开始 Intake Draft，也可以使用
完整命令 `/intake.submit`、`/intake.feedback`、`/intake.suggest`。随后可连续发送文字、
图片和文件；单独发送固定关键词 `提交` 才会建立 Intake Record，发送 `取消` 放弃草稿。
`/intake` 列出自己的记录，`/intake 反馈#1` 等命令查看详情。三类稳定标识符分别是
`投稿#<自然数>`、`反馈#<自然数>`、`建议#<自然数>`，编号不会复用。

提交后，系统先保存记录，再向配置的 QQ 目标发送摘要和转发消息。通知失败不回滚记录，
而是进入自动重试；用户能看到“已送达”或“暂时延迟”的明确结果。管理员应当直接通过
QQ 联系提交者，Bot 不承载管理员与提交者之间的回复会话。

管理员可引用管理通知并发送以下固定动作：

- 通用：`认领`、`转交 <QQ号>`、`取消认领`、`关闭`、`重开`（`打开`也是重开）。
- 反馈：`处理中`、`已解决`。
- 投稿：`通过`、`拒绝`。
- 建议：`接受`、`拒绝`。

也可使用 `/intake.admin.list`、`.get`、`.status`、`.note`、`.claim`、`.transfer`、
`.unassign`、`.close`、`.reopen` 执行同类管理动作。处理进度与是否留在活跃工作队列
是两套状态：关闭或重开记录不会抹掉其处理结论。

## FAQ

主要配置是 `administrators`、`managementGroups` 和 `pageSize`（默认 10，范围
1–50）。成员使用 `/faq` 查看第一页、`/faq <页码>` 翻页、`/faq #<自然数>` 查看完整
答案；FAQ 的稳定标识符为 `#<自然数>`。

管理员使用 `/faq.add`、`/faq.edit #N`、`/faq.hide #N`、`/faq.show #N`、
`/faq.rm #N` 和 `/faq.manage`。引导流程只有收到固定关键词 `确认` 才提交，其他输入
取消；编辑字段只接受 `问题`、`答案`、`两者`。删除采用显式的两阶段流程：先隐藏，
再确认永久删除。普通成员看不到隐藏条目，管理员仍可检查和恢复其公开状态。

## Activity

主要配置：

- `administrators`、`managementGroups`：管理员身份与管理群位置。
- `notificationUsers`、`notificationGroups`：保存时可选择通知的 QQ 用户和群。

成员使用 `/activity` 查看即将开始或进行中的活动，使用 `/activity #<自然数>` 查看
详情；活动标识符为 `#<自然数>`。管理员使用 `/activity.history` 查看已结束或已取消
活动，并通过 `/activity.add`、`/activity.edit <编号>`、`/activity.cancel <编号>` 完成
管理。

新增和编辑时，可选字段发送固定占位符 `-` 表示跳过；编辑字段只接受 `标题`、`开始`、
`结束`、`地点`、`链接`、`描述`。最终必须选择 `仅保存` 或 `保存并通知`，其他输入取消。
系统校验起止时间和 HTTP(S) 链接，保存后返回完整活动详情；选择通知时再向配置的 QQ
目标广播同一详情。

## Archive

Archive 必须同时获得 Koishi Database 和 Console 服务。领域词汇 **Newspaper Issue**
在现有 QQ 命令和 Archive WebUI 中显示为 **Paper**；下文使用 Paper 时均指同一概念。
主要配置：

- `administrators`、`managementGroups`：管理员身份与管理群位置。
- `localPath`：主附件目录，默认 `data/memebot-archive`。
- `paperMaxMb`、`workMaxMb`：Paper PDF 和 Work ZIP 上限，默认 100 MB、500 MB。
- `r2.enabled` 及 `accountId`、`bucketName`、`accessKeyId`、`secretAccessKey`、
  `objectPrefix`：可选的 Cloudflare R2 S3 API 备份。启用后凭据必须完整。

Paper 使用 `P<自然数>`，Work 使用 `W<自然数>`；Archive Identifier 在移除、恢复和
取回期间保持不变且不会复用。每个 Paper 的附件是一个 PDF，每个 Work 必须有且只有
一个 ZIP Work Package。Publication Appearance 显式连接 Paper 与 Work，并可记录页码、
栏目和显示顺序。

### QQ 快捷命令

成员可用 `/archive.search paper [查询]`、`/archive.search works [查询]` 搜索，或使用
`/archive P1`、`/archive W1` 获取详情与附件。管理员常用快捷命令包括：

- `/archive.publish.paper`、`/archive.publish.works`：引导上传并发布 PDF/ZIP。
- `/archive.edit.paper P1`：引导编辑 Paper 元数据。
- `/archive.rm P1` 或 `/archive.rm W1`：预览后软删除。
- `/archive.retry`：立即重试待同步的 R2 附件。

引导发布、编辑、移除只有收到固定关键词 `确认` 才继续；可选文本发送 `-` 跳过。
底层紧凑管理命令的确认参数固定为大写 `Y`。这些 QQ 命令是高频操作的快捷入口，
不是完整管理界面。

### Archive WebUI

Koishi Console 中的 Archive WebUI 是完整管理入口，覆盖：

- 本地与 R2 预检状态、重新预检、备份队列状态和立即重试。
- Paper/Work 的搜索、新建、编辑、附件替换、预览和下载。
- Work Package 文件树与完整预览；HTML、SVG 等 Web 内容仅作为派生数据在受限
  `sandbox` iframe 中显示，ZIP 始终是权威附件。
- Publication Appearance 的双向详情、关联现有 Work、新建并关联 Work、解除关联，
  以及页码、栏目和顺序信息。
- 30 天软删除、恢复、提前清除、匿名化、替换附件的保留与恢复、生命周期历史。
- 从 R2 清单生成恢复预览，检查新增、变化和冲突，选择本地或 R2 元数据后应用，
  并查看恢复历史。

附件首先持久写入本地目录；本地写入成功即表示归档成功。R2 失败只会把备份标记为
可重试，不会使用户操作失败。读取也优先使用本地副本。本地预检失败会禁用附件写入，
R2 预检失败则以本地可用的降级状态继续运行。

## 本地开发与验收

仓库根目录负责四个独立插件的构建和测试：

```sh
yarn install --immutable
yarn typecheck
yarn build
yarn test
yarn check:plugin-loads
```

本地 Koishi 集成实例位于被 Git 忽略的 `app/` 独立 Yarn 项目。它通过 `file:` 依赖加载
四个插件，并配置 Database、Console、Sandbox 和 Archive WebUI：

```sh
cd app
yarn start
```

在 Sandbox 中分别以成员和管理员身份走通 Intake、FAQ、Activity、Archive 上述紧凑
命令；在 Console 的 Archive 页面验证预检、Paper/Work、完整 Work 预览、Publication
Appearance、软删除、备份重试和恢复预览。`app/` 的配置、数据库、日志、缓存、环境文件
和依赖均不得提交或发布。

默认测试完全使用内存或临时目录中的替身，不访问真实 R2。若要额外验证真实 R2，先为
测试准备专用桶，再只通过部署环境注入下列变量；不要把值写入仓库、命令历史或日志：

```text
MEMEBOT_R2_ACCOUNT_ID
MEMEBOT_R2_BUCKET_NAME
MEMEBOT_R2_ACCESS_KEY_ID
MEMEBOT_R2_SECRET_ACCESS_KEY
```

四项都存在时，可运行：

```sh
yarn vitest run plugins/memebot-archive/tests/r2.integration.test.ts
```

该可选测试会写入、读取、校验并删除诊断对象；未提供变量时自动跳过。

## 发布插件

在 GitHub Actions secrets 中配置 npm access token `NPM_TOKEN`。更新目标插件自己的
`package.json` 版本，完成全仓验证后，创建并单独推送
`<插件目录>-v<package.json 版本>` 格式的 tag：

```sh
git tag memebot-faq-v0.1.1-alpha.4
git push origin memebot-faq-v0.1.1-alpha.4
```

发布工作流会校验 tag 与插件版本，检查并构建整个仓库，然后只发布该 tag 对应的独立
插件包。预发布版本使用首个后缀作为 npm dist-tag；稳定版本使用 `latest`。
