# NFD
No Fraud / Node Forward Bot

基于Cloudflare Workers的Telegram消息转发Bot，集成了反欺诈功能

## 特点
- 基于Cloudflare Workers搭建，能够实现以下效果
    - 搭建成本低，一个js文件即可完成搭建
    - 不需要额外的域名，利用Workers自带域名即可
    - 基于Workers KV/D1实现永久数据储存
    - 稳定，全球CDN转发
- 接入反欺诈系统，当聊天对象有诈骗历史时，自动发出提醒
- 支持屏蔽用户，避免被骚扰

## 搭建方法
1. 从[@BotFather](https://t.me/BotFather)获取Token，并且可以发送`/setjoingroups`来禁止此Bot被添加到群组
2. 从[UUID Generator](https://www.uuidgenerator.net)获取一个随机UUID作为Secret
3. 从[@userinfobot](https://t.me/userinfobot)获取你的用户ID
4. 登录[Cloudflare Workers](https://workers.cloudflare.com)，创建一个Worker
5. 配置Worker的变量
    - 增加一个`ENV_BOT_TOKEN`变量，数值为从步骤1中获得的Token
    - 增加一个`ENV_BOT_SECRET`变量，数值为从步骤2中获得的Secret
    - 增加一个`ENV_ADMIN_UID`变量，数值为从步骤3中获得的用户ID
    - 增加一个`ENV_DB_TYPE`变量，可以设置为KV或D1，默认为KV，推荐配置D1
    - 增加一个`ENV_DB_NAME`变量，为KV或D1设置名称， 默认为'nfd'
    - 增加一个`ENV_TIMEZONE`变量，设置时区，默认为'UTC'
6. 绑定KV/D1数据库，创建一个Name为`nfd`的KV/D1数据库，在Worker的Settings -> Bindings中配置`KV/D1 Binding`：nfd -> nfd
7. 点击`Quick Edit`，复制[这个文件](./worker.js)到编辑器中
8. 打开`https://xxx.workers.dev/registerWebhook`来注册
9. 如需切换数据库, 可打开`https://xxx.workers.dev/unRegisterWebhook`来反注册

## 使用方法
- 当其他用户给Bot发消息，会被转发到Bot创建者
- 用户回复普通文字给转发的消息时，会回复到原消息发送者
- 用户回复`/block`, `/unblock`, `/checkblock`等命令会执行相关指令，**不会**回复到原消息发送者

## 欺诈数据源
- 文件[fraud.db](./fraud.db)为欺诈数据，格式为每行一个UID
- 可以通过PR扩展本数据，也可以通过提Issue方式补充
- 提供额外欺诈信息时，需要提供一定的消息出处

## Thanks
- [telegram-bot-cloudflare](https://github.com/cvzi/telegram-bot-cloudflare)
