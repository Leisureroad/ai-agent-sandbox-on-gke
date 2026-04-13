# AI Agent Sandbox Solutions on GKE

This repository provides three distinct solutions for running AI Agents and Sandboxes on Google Kubernetes Engine (GKE), catering to different use cases from general code execution to enterprise agent assistants.

---

## 🗺️ Choose Your Scenario

| Solution | Targeted Use Case | Primary Feature | Deployment Method |
| :--- | :--- | :--- | :--- |
| **[General AI Sandbox](./sandbox/README.MD)** | **General Code Execution** | Foundational Infrastructure, Sandbox Router & Gateway, Sandbox warmpool, dynamic claims. | 📖 Step-by-Step Manual |
| **[OpenClaw Agent](./openclaw/README.MD)** | **AI Agent Assistant** | Visual UI, Multi-tool orchestration, Enterprise-ready. | 🚀 Cloud Build (One-Click) |
| **[Hermes Agent](./hermes/README.MD)** | **AI Agent Assistant** | 🆕 **Trending!** Lightweight (Minimal resources), Cost-efficient, Feishu/Lark integration. | 🚀 Cloud Build (One-Click) |

---

## ✨ Key Solution Highlights

Across all solutions, GKE infrastructure provides high-end features that ensure security, performance, and reliability:
### 🏛️ Scalable Multi-Tenancy (K8s Agent Sandbox)
Based on the `kubernetes-sigs/agent-sandbox` standard, this project implements a massive, scalable, and isolated multi-tenant execution environment. 
- **Warm Pools**: Maintains a buffer of ready-to-use sandboxes, reducing "claim" latency to sub-second levels.
- **Dynamic Claiming**: Agents claim sandboxes on-demand via a native `Sandbox` CRD lifecycle.
- **Sandbox Router**: A secure, high-performance router that dynamically connects clients to their isolated execution environments.

### 🛡️ Zero-Secret Security (Workload Identity)
By integrating **LiteLLM Proxy** with GKE **Workload Identity**, agents authenticate with Vertex AI using Google Service Accounts (GSA) automatically. **No more static API keys in environment variables.**

### ⚡ Fast Startup & Cost-Efficiency (GCFS + Pod Snapshot)
We combine **Image Streaming (GCFS)** with **Pod Snapshots** to achieve second level sandbox recovery. **Image Streaming** allows massive images to start execution immediately while data is being pulled in the background, and **Pod Snapshots** dramatically reduce **Pod Resume Latency**. This synergy enables aggressive autoscaling and **Economic Operation**, significantly saving infrastructure costs by only keeping Pods active when needed.
*Note: Snapshotting currently only supports the **gVisor** runtime.*

### 📁 Enterprise Governance & Stability (InitContainer)
For **Hermes** and **OpenClaw**, we use a robust `initContainer` pattern to initialize configurations on PVCs. This approach empowers SRE teams to **standardize AI Assistant templates**. It lowers the cost of manual configuration and makes **security governance** easier across the organization through standardized, repeatable deployment patterns.

---

## 📂 Repository Structure

- [`/terraform`](./terraform): Common GKE Infrastructure (VPC, Node Pools for Kata/gVisor).
- [`/sandbox`](./sandbox): General AI Sandbox infrastructure, router, and manuals.
- [`/openclaw`](./openclaw): Automated deployment solution for the OpenClaw Agent.
- [`/hermes`](./hermes): Automated deployment solution for Hermes Agent.