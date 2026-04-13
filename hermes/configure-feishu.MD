   配置飞书（Feishu）与 Hermes Agent 集成的步骤主要分为两部分：在**飞书开放平台**创建应用，以及在 **Hermes**
   中配置环境变量。

   以下是详细步骤：

   ### 第一步：在飞书开放平台创建应用

   1.  **登录开放平台**：访问 [飞书开放平台](https://open.feishu.cn/app)，使用飞书账号登录。
   2.  **创建自建应用**：点击“创建自建应用”，填写应用名称和描述。
   3.  **获取凭证**：在“凭证与基础信息”页面，找到并记录 **App ID** 和 **App Secret**。
   4.  **启用机器人功能**：在左侧菜单点击“应用功能” -> “机器人”，点击“启用机器人”。
   5.  **配置事件订阅（可选，用于接收消息）**：
       *   在“事件订阅”页面，设置 **Verification Token** 和 **Encrypt Key**（建议设置以增强安全性）。
       *   配置请求网址（Request URL），通常为 `http://your-server:8644/feishu/webhook`。
       *   添加需要的事件权限，如 `接收消息` (im.message.receive_v1)。
   6.  **权限管理**：在“权限管理”中，搜索并添加 `获取与发送单聊、群聊消息` 等必要权限。
   7.
   **发布应用**：在“版本管理与发布”中，点击“创建版本”，填写版本号并保存，然后点击“申请发布”。企业管理员审核通过后
   ，应用即可生效。

   ### 第二步：在 Hermes 中配置

   你可以通过修改 `~/.hermes/.env` 文件或设置环境变量来完成配置。

   #### 方法 A：修改 .env 文件
   编辑 `~/.hermes/.env`，添加以下内容：

   ```bash
   FEISHU_APP_ID=cli_xxxxxxxxxxxxxx
   FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   # 如果设置了加密，请添加以下项
   FEISHU_ENCRYPT_KEY=xxxxxxxxxxxx
   FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxx
   # 默认域名为 feishu，如果是国际版 Lark，可设置为 lark
   FEISHU_DOMAIN=feishu
   ```

   #### 方法 B：修改 config.yaml
   编辑 `~/.hermes/config.yaml`：

   ```yaml
   platforms:
     feishu:
       enabled: true
       extra:
         app_id: "cli_xxxxxxxxxxxxxx"
         app_secret: "xxxxxxxxxxxxxxxxxxxxxxxx"
         encrypt_key: "xxxxxxxxxxxx"
         verification_token: "xxxxxxxxxxxx"
         domain: "feishu"
   ```

   ### 第三步：启动 Gateway

   配置完成后，重启 Hermes Gateway 以应用更改：

   ```bash
   hermes gateway run
   ```

   ### 常用验证命令

   *   **检查状态**：使用 `hermes gateway status` 查看飞书平台是否已成功加载。
   *   **发送测试消息**：你可以尝试在飞书中向机器人发送消息，或者通过 Hermes CLI 触发推送任务。

   如果你需要将飞书作为定时任务（Cron）的接收端，可以使用 `--deliver feishu` 参数，例如：
   `hermes cron create --name "Daily Report" --schedule "0 9 * * *" --deliver feishu --deliver-chat-id
   "oc_xxxxxx" --prompt "总结昨天的进展"`