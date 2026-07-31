# MemeBot

面向 QQ 社团运营场景的 Koishi 插件集合。每个 `plugins/memebot-*` 都是可以独立安装、配置和发布的插件。

## 开发

```sh
yarn install
yarn dev
```

Koishi 开发实例位于 `apps/koishi-dev`，默认控制台地址为 `http://localhost:5140`。

```sh
yarn typecheck
yarn build
```

## 插件

- `koishi-plugin-memebot-ticket`：分类投稿与工单。
- `koishi-plugin-memebot-faq`：常见问题菜单与查询。
- `koishi-plugin-memebot-help`：帮助文档与戳一戳响应。
- `koishi-plugin-memebot-broadcast`：活动通知与广播。
