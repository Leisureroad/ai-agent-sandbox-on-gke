### 第一步：在飞书开放平台创建应用

 1. 登录平台：访问 飞书开放平台 (https://open.feishu.cn/app)。如果是国际版租户，请访问 Lark Open Platform
 (https://open.larksuite.com/app)。
 2. 创建应用：点击“创建企业自建应用”，填写名称和描述。
 3. 获取凭证：在“凭证与基础信息”中记录下 App ID 和 App Secret。
 4. 配置权限：
     - 在“权限管理”中选择“批量导入”。
     - 粘贴以下 JSON（包含消息读取、发送、机器人能力等核心权限）：
   ```json

 {"scopes":{"tenant":["aily:file:read","aily:file:write","application:application.app_message_stats.overview:readonly","application:a
 pplication:self_manage","application:bot.menu:write","cardkit:card:read","cardkit:card:write","contact:user.employee_id:readonly","c
 orehr:file:download","event:ip_list","im:chat.access_event.bot_p2p_chat:read","im:chat.members:bot_access","im:message","im:message.
 group_at_msg:readonly","im:message.p2p_msg:readonly","im:message:readonly","im:message:send_as_bot","im:resource"],"user":["aily:fil
 e:read","im:chat.access_event.bot_p2p_chat:read"]}}
   ```
 5. 启用机器人：在“应用能力” -> “机器人”中，点击“启用机器人”。
 6. 事件订阅（关键）：
     - 在“事件订阅”中，选择 “使用长连接接收事件” (WebSocket)。
     - 点击“添加事件”，搜索并添加 im.message.receive_v1 (接收消息 v1.0)。
 7. 发布应用：在“版本管理与发布”中创建版本并申请上线，等待 管理员通过。

 ────────────────────────────────────────────────────────────────────────────────

 ### 第二步：在 OpenClaw 中配置

 你有两种方式添加凭证：

 方法 A：使用命令行向导（推荐）
 在终端运行：

 ```bash
   openclaw channels add
 ```

 选择 Feishu，然后按提示输入你的 App ID 和 App Secret。

 方法 B：手动修改配置文件
 编辑 ~/.openclaw/openclaw.json，在 channels 下添加：

 ```json5
   {
     "channels": {
       "feishu": {
         "enabled": true,
         "accounts": {
           "main": {
             "appId": "你的_App_ID",
             "appSecret": "你的_App_Secret"
           }
         }
       }
     }
   }
 ```

 ────────────────────────────────────────────────────────────────────────────────

 ### 第三步：启动并激活

 1. 重启网关：
   ```bash
     openclaw gateway restart
   ```
 2. 发送消息：在飞书中找到你的机器人，给它发个“你好”。
 3. 批准配对：机器人会回复一个 6 位数的配对码。在终端运行：
   ```bash
     openclaw pairing approve feishu <配对码>
   ```

 小贴士：
 - 如果你使用的是 Lark (国际版)，请在配置中添加 "domain": "lark"。
 - 默认情况下，群聊需要 @机器人 才会响应。
 - 你可以运行 openclaw logs --follow 来查看连接是否成功。