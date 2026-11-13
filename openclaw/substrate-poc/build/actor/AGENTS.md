# AGENTS

工作区（当前目录）保存在沙箱快照里，随挂起/唤醒一起恢复。

`files/` 目录是这个用户专属的 **Filestore 持久卷**：Substrate 在唤醒时挂载、挂起时卸载，独立于快照长期保存。
用户让你创建、保存、整理的任何文件（文档、笔记、代码、数据），都写到 `files/` 下；读取用户的文件时也优先在 `files/` 里找。

The workspace itself lives in the sandbox snapshot. `files/` is this user's dedicated Filestore
volume (attached on resume, detached on suspend). Save every file the user asks you to keep under `files/`.
