# ShoppingMall 对接补丁（可选）

小鲸 AI 助手想用「查价 / 买 / 卖 / 回收排行」，需要 ShoppingMall 对外暴露三个只读+交易转发入口。

ShoppingMall 本身没有导出任何函数（没有 ll.exports），所以只能在它源码末尾追加一段。

## 怎么装

1. 确认服务器已经装了 ShoppingMall 3.6.x（作者：子邪EVILZIXIE，https://www.minebbs.com/resources/sm.9899/ ）
2. 在本文件夹里执行（把路径换成你自己的）：

```
node apply-hook.js "D:/bedrock/plugins/ShoppingMall/ShoppingMall.js"
```

3. 重启服务器，日志里看到下面这行就成了：

```
[ShoppingMall] [AI 接口] 已开放 sm_aiQuery / sm_aiBuy / sm_aiSell
```

## 说明

- 只会**追加**，不修改原来的任何逻辑；原件会自动备份成 `ShoppingMall.js.bak-aihook-<日期>`
- 不装补丁也能用助手，只是「查价 / 买 / 卖 / 回收排行」会提示没装商城
- 以后升级 ShoppingMall 会整文件覆盖，钩子会掉，重跑一次 apply-hook.js 就行
- 本补丁只是调用商城自己的官方商店数据与买卖流程，没有改它的价格、税率、库存逻辑