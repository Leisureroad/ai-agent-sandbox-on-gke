# GKE 上的 AI Agent 沙箱解决方案

本仓库提供三种在 Google Kubernetes Engine (GKE) 上运行 AI Agent 和沙箱的独立解决方案。涵盖了从通用代码执行到企业级代理助理的各种应用场景。

---

## 🗺️ 选择您的场景

| 解决方案 | 目标应用场景 | 核心特性 | 部署方式 |
| :--- | :--- | :--- | :--- |
| **[通用 AI 沙箱](./sandbox/README_ZH.MD)** | **通用代码执行** | 基础设施底座、沙箱路由与网关、预热池、动态申领。 | 📖 手动安装指南 |
| **[OpenClaw Agent](./openclaw/README_ZH.MD)** | **AI 代理助理** | 可视化 UI、多工具编排、企业级就绪。 | 🚀 Cloud Build (一键部署) |
| **[Hermes Agent](./hermes/README_ZH.MD)** | **AI 代理助理** | 🆕 **热门推荐!** 轻量化（极低资源占用）、高性价比、支持飞书/Lark 集成。 | 🚀 Cloud Build (一键部署) |

---

## ✨ 核心技术亮点

在所有方案中，GKE 基础设施均提供了一系列高端特性，确保环境的安全性、高性能和可靠性：

### 🏛️ 可扩展的多租户架构 (K8s Agent Sandbox)
本项目基于 `kubernetes-sigs/agent-sandbox` 标准，实现了大规模、可扩展且物理隔离的多租户执行环境。
- **预热池 (Warm Pools)**: 维持一定数量的就绪沙箱缓冲区，将沙箱“申领（Claim）”延迟降低至亚秒级。
- **动态申领**: Agent 通过原生的 `Sandbox` CRD 生命周期按需动态申领沙箱。
- **沙箱路由器 (Sandbox Router)**: 安全且高性能的路由器，负责将客户端动态连接到其独立的执行环境。

### 🛡️ 零密钥安全保障 (Workload Identity)
通过将 **LiteLLM Proxy** 与 GKE **Workload Identity** 结合，Agent 无需硬编码 API Key，即可自动使用 Google 服务账号 (GSA) 对 Vertex AI 进行身份验证。**环境变量中不再包含敏感的静态 API 密钥。**

### ⚡ 极速启动与经济运行 (GCFS + Pod Snapshot)
我们结合了 **镜像流 (GCFS)** 与 **Pod 快照 (Pod Snapshot)** 技术，实现了秒级的沙箱恢复体验。
- **镜像流**: 允许超大镜像在数据后台拉取的同时立即开始执行任务。
- **Pod 快照**: 大幅缩短了 **Pod 恢复延迟 (Resume Latency)**。
这种协同效应支持更激进的弹性伸缩与 **“经济运行（Economic Operation）”**，通过仅在需要时保持 Pod 活跃，显著节省基础设施成本。
*注：快照功能目前仅支持 **gVisor** 运行时。*

### 📁 企业级治理与稳定性 (InitContainer)
针对 **Hermes** 和 **OpenClaw**，我们采用了稳健的 `initContainer` 模式在 PVC 上初始化配置。此方案不仅解决了技术上的挂载冲突，更为 SRE 团队提供了 **标准化的 AI 助理模板**，降低了手动配置成本，并通过标准化、可重复的部署模式简化了全组织的安全治理。

---

## 📂 仓库结构

- [`/terraform`](./terraform): 通用 GKE 基础设施（VPC、支持 Kata/gVisor 的节点池、IAM 权限）。
- [`/sandbox`](./sandbox): 通用 AI 沙箱基础设施、路由器及操作手册。
- [`/openclaw`](./openclaw): OpenClaw 代理平台的自动化部署方案。
- [`/hermes`](./hermes): Hermes 代理的自动化部署方案。

---
*Built with ❤️ for the AI Agent community on Google Cloud.*
