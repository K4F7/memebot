# MemeBot

面向 QQ 社团运营场景的 Koishi 插件集合。仓库包含 Access 与四个业务插件；每个
`plugins/memebot-*` 都可以独立安装、配置、构建和发布。唯一的插件间运行时依赖例外是：
具有受保护操作的业务插件必须使用 `koishi-plugin-memebot-access` 作为中央授权来源。
Access 本身不依赖任何业务插件，业务插件之间也不互相依赖。

## 插件与端到端流程

| 插件 | 配置 | 用户动作 | 系统处理 | 管理员动作 | 可观察结果 |
| --- | --- | --- | --- | --- | --- |
| `koishi-plugin-memebot-access` | 首次启动配置 QQ 管理员与 Management Group 种子，并提供 Database 和 Console | 成员照常使用各业务插件，无需单独申请 Access | 从数据库统一判断管理员身份和群聊状态变更位置 | 用 Console 或 `access.*` 命令维护全局授权集合 | 授权变更对下一次操作立即生效；拒绝结果区分身份与位置 |
| `koishi-plugin-memebot-intake` | 为投稿、反馈、建议分别配置 QQ Notification Group/用户目标和附件目录 | 在 QQ 中开始收集并连续发送文字或附件 | 保存 Intake Draft，提交后生成稳定编号并投递管理通知；失败通知自动重试 | 引用管理通知认领、转交、变更状态、关闭或重开 | 用户获得 `投稿#N`、`反馈#N` 或 `建议#N`，并可查询自己的记录 |
| `koishi-plugin-memebot-faq` | 配置公开列表页大小，并加载 Access | 在 QQ 中分页浏览或按 `#N` 查询 | 只向普通成员展示公开条目 | 新增、编辑、隐藏、重新公开；已隐藏条目才可永久删除 | 用户看到稳定的 FAQ 编号、问题和答案 |
| `koishi-plugin-memebot-activity` | 配置 QQ 用户/Notification Group 通知目标，并加载 Access | 在 QQ 中查看近期活动或按 `#N` 查询 | 根据开始、结束时间计算近期与历史状态 | 引导新增、编辑、取消，并选择仅保存或同时通知 | 用户看到活动时间、状态、地点、描述和链接；被选中的 QQ 目标收到通知 |
| `koishi-plugin-memebot-archive` | 无需内容后端配置；插件保持可安装 | 在 QQ 中搜索或按 `W<N>` 获取 Work | 内容后端未绑定时 fail-closed，返回暂时不可用 | Archive 管理不在本仓库；QQ 不提供写入或运维命令 | 成员收到暂时不可用结果；后续适配器可恢复有序图片/PDF 投递 |

Access 为三个受保护业务插件提供同一套授权规则；Archive 仅提供公开 QQ 读取命令，
不属于 Access 的运行时消费者。显式记录的 QQ 用户或 Koishi authority 不低于
4 的用户是 Plugin Administrator。Management Group 只限制群聊中的状态变更位置，不会
把群成员变成管理员；管理员只读不受位置限制，私聊状态变更仍要求管理员身份，空
Management Group 集合拒绝所有群聊状态变更。Notification Group 仍由对应业务插件配置，
只负责接收业务通知。插件只按 QQ 用户和 QQ 群路由，不提供非 QQ 路由或可配置的 authority
阈值。

## Access

部署时为 Access 提供 Koishi Database 和 Console。`administrators` 与
`managementGroups` 是首次初始化种子：Access 将它们与初始化标记原子写入数据库，之后
数据库成为唯一授权来源；即使管理员主动清空集合，重启也不会再次导入配置。QQ 号和群号
都使用去除首尾空格后的纯十进制字符串。

普通成员无需执行 Access 命令，仍可在任意 QQ 群或私聊使用 Intake、FAQ、Activity 与
Archive 的普通服务。Plugin Administrator 可使用：

- `access.admin.add <QQ>`、`access.admin.rm <QQ>`：新增或移除显式管理员。
- `access.group.add <群号>`、`access.group.rm <群号>`：新增或移除 Management Group。
- `access.list`：在任意群或私聊查看显式管理员与 Management Group。

`add` 和 `rm` 是状态变更，须满足身份与当前位置规则；`access.list` 是管理员只读。聊天侧
不能移除操作者自己的显式管理员记录，重复新增或移除不存在的记录会返回幂等结果。Console
可维护全部显式记录。安装 Koishi Auth/Login 时，登录前既不显示受保护页面，也不能调用其
后端接口；未安装时，Console 沿用 Koishi 的开放行为。成功变更会立即影响下一次授权判断。

## Intake

主要配置：

- `targets.submission`、`targets.feedback`、`targets.suggestion`：每类 Intake 的
  `users` 和 `groups` QQ 通知目标；没有目标的类型不能开始收集。
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

主要配置是 `pageSize`（默认 10，范围 1–50）；受保护操作统一使用 Access。成员使用
`/faq` 查看第一页、`/faq <页码>` 翻页、`/faq #<自然数>` 查看完整答案；FAQ 的稳定
标识符为 `#<自然数>`。

管理员使用 `/faq.add`、`/faq.edit #N`、`/faq.hide #N`、`/faq.show #N`、
`/faq.rm #N` 和 `/faq.manage`。引导流程只有收到固定关键词 `确认` 才提交，其他输入
取消；编辑字段只接受 `问题`、`答案`、`两者`。删除采用显式的两阶段流程：先隐藏，
再确认永久删除。普通成员看不到隐藏条目，管理员仍可检查和恢复其公开状态。

## Activity

主要配置：

- `notificationUsers`、`notificationGroups`：保存时可选择通知的 QQ 用户和群。

成员使用 `/activity` 查看即将开始或进行中的活动，使用 `/activity #<自然数>` 查看
详情；活动标识符为 `#<自然数>`。管理员使用 `/activity.history` 查看已结束或已取消
活动，并通过 `/activity.add`、`/activity.edit <编号>`、`/activity.cancel <编号>` 完成
管理。

新增和编辑时，可选字段发送固定占位符 `-` 表示跳过；编辑字段只接受 `标题`、`开始`、
`结束`、`地点`、`链接`、`描述`。最终必须选择 `仅保存` 或 `保存并通知`，其他输入取消。
系统校验起止时间和 HTTP(S) 链接，保存后返回完整活动详情；回复会分别说明记录已保存，
以及通知未请求、未配置、已送达或发送失败。通知失败不会回滚已经保存的活动记录。

## Archive

`memebot-archive` 是 QQ 只读归档插件。它不注入 Koishi Database、Console 或
`memebot-access`，也不创建 Archive 表、写入本地附件、上传 ZIP、维护清单或执行生命周期
操作。旧本地附件库、Archive 表、Console WebUI、ZIP Work Package 与生命周期命令保持
退役。内容管理不在本仓库；Payload 实现冻结在 `archive/payload-cms`，本仓库 `main`
不再构建、配置或部署 Payload。首版内容平台运行在独立的 `K4F7/cms`。在内容后端适配器
落地前，公开读取命令 fail-closed。

插件当前无需内容后端配置项。

### QQ 只读命令

- `/archive.search works [查询]`：搜索 Work。
- `/archive.works [查询]`：搜索 Work 的兼容快捷写法。
- `/archive.work-query [作者] [查询]`：按作者或文本搜索 Work。
- `/archive W1`：获取 Work 详情及有序图片/PDF Media。

在没有内容后端时，上述命令返回 `Archive 服务暂时不可用，请稍后重试。`。后续适配器
绑定 Archive Read Contract 后，成员可见结果应恢复为 Work 详情与有序图片/PDF 投递；
未知或不可读 Work 须与缺失后端保持区分，不可把配置失败复用为 `Work 不存在。`。

QQ 不提供 Archive 上传、编辑、删除、恢复、备份重试或其他管理命令；Paper、Publication
Appearance、ZIP Work Package 和旧 Koishi Archive WebUI 属于已退役或后续独立范围。

## 本地开发与验收

仓库根目录负责 Access 与四个业务插件的构建和测试。`yarn check:plugin-artifacts`
是独立包边界（independent package boundary）：它用 Yarn 把每个插件打成 tarball，
在隔离的临时目录里检查解包后的产物（而不是源码 workspace），并在结束后清掉这些
文件。该检查拒绝缺失的入口和类型声明、残留的 `workspace:` 依赖，以及无法作为
Koishi 插件加载的 CommonJS 入口。

```sh
yarn install --immutable
yarn typecheck
yarn build
yarn test
yarn check:plugin-loads
yarn check:plugin-artifacts
```

本地 Koishi 集成实例位于被 Git 忽略的 `app/` 独立 Yarn 项目。它通过 `file:` 依赖加载
五个插件，并配置 Database、Console 与 Sandbox；Archive 在其中无需 Payload 或其它内容
后端配置即可加载，读取命令保持 fail-closed。

```sh
# 首次创建（使用官方 Koishi scaffold）
yarn dlx create-koishi@latest app --yes

# file: 依赖会在安装时快照插件产物，因此先在仓库根构建
yarn build

# 先创建空 app/yarn.lock，确保它不会被根 workspace 接管；再在 app/package.json
# 中将五个 memebot 包配置为 file:../plugins/memebot-*，并用 resolutions 将
# koishi-plugin-memebot-access 固定为 file:../plugins/memebot-access（业务包的
# workspace:^ 依赖在独立 app 中需要这项解析），
# 并在 app/koishi.yml 中启用 Database、Console、Sandbox 与五个插件后：
cd app
yarn install
cd ..

# 回到仓库根，执行会在环境不可用或启动报错时失败的集成冒烟检查
yarn smoke:local-app

# 需要持续操作 Console 或 Sandbox 时单独启动
cd app
yarn start
```

在 Sandbox 中分别以成员和 Plugin Administrator 身份走通 Access、Intake、FAQ 与 Activity
命令；Archive 的 QQ 验收覆盖命令仍已注册，并在无内容后端时返回暂时不可用结果。Archive
管理不在本仓库执行。
`app/` 的配置、数据库、日志、缓存、环境文件和依赖均不得提交或发布。
`yarn smoke:local-app` 会先校验五个本地依赖与必需服务配置，再启动实例、探测 Console，
并把启动日志中的可见失败作为非零退出；缺失 `app/`、端口被占用或服务不可用都不是成功。

默认测试不访问生产数据库、真实 R2 或任何内容平台。Archive 的当前 QQ 验收路径见
[`docs/testing/archive-qq-shortcuts.md`](docs/testing/archive-qq-shortcuts.md)；管理面说明见
[`docs/testing/archive-console-browser.md`](docs/testing/archive-console-browser.md)。
Vercel 部署属于 `K4F7/cms`，不再由本仓库触发。

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
