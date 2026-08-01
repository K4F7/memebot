# MemeBot

面向 QQ 社团运营场景的 Koishi 插件集合。每个 `plugins/memebot-*` 都是可以独立安装、配置和发布的插件。

## 开发

```sh
yarn install
```

```sh
yarn typecheck
yarn build
```

## 发布插件

在仓库的 GitHub Actions secrets 中配置 npm access token，名称为
`NPM_TOKEN`。然后创建并推送格式为
`<插件目录>-v<package.json 版本>` 的 tag：

```sh
git tag memebot-faq-v0.1.0
git push origin memebot-faq-v0.1.0
```

发布工作流会校验 tag 与插件版本，完成全仓类型检查和构建后，只发布 tag
对应的插件。

## 插件

- `koishi-plugin-memebot-ticket`：分类投稿与工单。
- `koishi-plugin-memebot-faq`：常见问题菜单与查询。
- `koishi-plugin-memebot-help`：帮助文档与戳一戳响应。
- `koishi-plugin-memebot-broadcast`：活动通知与广播。
- `koishi-plugin-memebot-activity`：活动登记、查询与可选广播。
