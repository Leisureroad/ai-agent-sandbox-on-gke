## 目录
1. [前提条件](#前提条件)
2. [通过 Terraform 自动化构建基础设施](#通过-terraform-自动化构建基础设施)
4. [构建沙箱路由器与部署网关](#构建沙箱路由器与部署网关)
5. [部署 AI Agent 沙箱并进行测试](#部署-ai-agent-沙箱并进行测试)
6. [资源清理](#资源清理)

---

## 前提条件

在开始部署之前，请确保您的本地环境满足以下条件：

- **工具已安装**: 已安装并配置好 `terraform`、`kubectl` 和 `gcloud` 命令行工具。
- **Python 环境**: 本地已安装 Python 3.10+，用于运行沙箱客户端测试脚本。

```bash
# 设置环境变量
git clone https://github.com/Leisureroad/ai-agent-sandbox-on-gke.git
cd ai-agent-sandbox-on-gke
export ROOT_DIR=$(pwd)
export PROJECT_ID=<您的项目 ID>
export REGION=us-central1
export REPO_NAME=ai-sandbox-repo

# 开启必要的 API 服务
gcloud services enable cloudresourcemanager.googleapis.com container.googleapis.com servicenetworking.googleapis.com cloudbuild.googleapis.com compute.googleapis.com file.googleapis.com aiplatform.googleapis.com
```

---

## 通过 Terraform 自动化构建基础设施

我们通过 `terraform/` 目录下的配置文件提供了一键式基础设施构建，而不是在控制台手动点击。该脚本将执行以下关键配置：
- 为 Filestore 集成配置所需的 VPC 网络。
- 启用 **Filestore CSI 支持** 并设置 **GKE Gateway API** 控制平面。
- 创建两个专用节点池：
  - `kata-nodepool`: 专门为 **Kata Containers** 优化（运行 `n2-standard` 实例，并开启嵌套虚拟化）。
  - `gvisor-nodepool`: 配置为原生支持 GKE Sandbox 的 **gVisor** 节点池（`sandbox_type = "gvisor"`）。

### 执行基础设施构建

导航至 terraform 目录，根据需要调整变量，然后执行构建。

```bash
# 初始化 Terraform 空间
cd $ROOT_DIR/terraform
terraform init

# 执行基础设施构建
terraform apply -var="project_id=$PROJECT_ID"
```

Terraform 运行完成后，获取集群凭据以便 `kubectl` 可以部署应用资源：

```bash
# 获取新建集群的凭据
gcloud container clusters get-credentials ai-sandbox-cluster --region us-central1 --project <您的项目 ID>
```

```bash
# 安装 Kata Container 支持
export VERSION=$(curl -sSL https://api.github.com/repos/kata-containers/kata-containers/releases/latest | jq .tag_name | tr -d '"')
export CHART="oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy"

helm install kata-deploy "${CHART}" --version "${VERSION}"

# 查看所有可配置项
helm show values "${CHART}" --version "${VERSION}"
```
---

## 部署沙箱控制器 (Agent Sandbox Controller) 与 CRD

```bash
# 部署 Agent Sandbox 控制器及扩展组件
echo "📦 正在部署 Agent Sandbox Controller & CRDs..."
kubectl apply \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.2.1/manifest.yaml \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.2.1/extensions.yaml

# 等待控制器与 Webhooks 启动成功
echo "⏳ 正在等待 Agent Sandbox Webhooks 就绪..."
sleep 15
kubectl wait --for=condition=Ready=True pod --all -n agent-sandbox-system --timeout=120s  || true
```
---

## 构建沙箱路由器与部署网关

在运行部署脚本之前，您需要构建沙箱路由器（Sandbox Router）镜像并将其推送到您的镜像仓库。沙箱路由器是所有沙箱流量的核心入口，负责将请求动态路由到正确的沙箱实例。

### 1. 构建沙箱路由器镜像

首先，创建一个 Artifact Registry 仓库来存放镜像，并配置 Docker 验证：

```bash
# 创建 Artifact Registry 仓库
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="Docker repository for AI Sandbox images"

# 为 Docker 配置 Artifact Registry 验证
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# 进入沙箱路由器源码目录
cd $ROOT_DIR
git clone https://github.com/kubernetes-sigs/agent-sandbox.git
cd agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/

# 使用 Cloud Build 构建并推送镜像
export SANDBOX_ROUTER_IMG=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/sandbox-router:latest
gcloud builds submit --tag $SANDBOX_ROUTER_IMG .
```

### 2. 部署沙箱路由器与网关

将以下步骤保存为脚本或直接在终端运行。它将自动安装沙箱基础设施，配置 Filestore 持久化卷，并建立网络路由器与网关。

```bash
# 部署沙箱路由器
echo "🔄 正在部署 Sandbox Router..."
sed -i "" "s|IMAGE_PLACEHOLDER|${SANDBOX_ROUTER_IMG}|g" "$ROOT_DIR/agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml"
kubectl apply -f $ROOT_DIR/agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml

echo "🌐 正在通过 Gateway API 部署网络网关 (gateway.yaml)..."
kubectl apply -f $ROOT_DIR/sandbox/gateway.yaml

```
---

## 部署 AI Agent 沙箱并进行测试

### 部署 Filestore PVC 与沙箱模板

```bash
echo "💿 正在部署存储资源与沙箱模板..."
kubectl apply -f $ROOT_DIR/sandbox/storageclass.yaml
kubectl apply -f $ROOT_DIR/sandbox/kata/sandboxtemplate-kata.yaml
kubectl apply -f $ROOT_DIR/sandbox/gvisor/sandboxtemplate-gvisor.yaml
```

### 测试沙箱环境

基础设施部署完成后，您可以使用 `sandboxclient.py` 脚本测试沙箱的隔离性与创建性能。

#### 1. 安装客户端依赖

```bash
# 创建虚拟环境（推荐）
python3 -m venv venv
source venv/bin/activate

# 安装客户端及其依赖
pip install k8s-agent-sandbox==0.2.1
```

#### 2. 配置本地验证

确保您的本地环境已通过验证，可以代理 Kubernetes Gateway API 请求。

```bash
# 登录并获取应用默认凭据
gcloud auth login
gcloud auth application-default login
gcloud container clusters get-credentials ai-sandbox-cluster --region us-central1 --project <您的项目 ID>
```

#### 3. 运行客户端测试

执行测试脚本。该脚本将使用线程池并发发起沙箱申领请求，并在容器内通过 `df -Th` 命令验证存储挂载的隔离性，同时测试冷启动延迟。

```bash
# 执行 gvisor 沙箱测试
python $ROOT_DIR/sandbox/gvisor/sandboxclient-gvisor.py

# 执行 kata 沙箱测试
python $ROOT_DIR/sandbox/kata/sandboxclient-kata.py
```

#### 预期输出

您将看到日志记录了申领和初始化沙箱所需的时间，随后输出容器内挂载的存储列表（包括 `/data` 目录下的 Filestore 挂载）。这证明了预热池可以优雅地处理即时的并发请求。

---

## 资源清理

运行以下命令以销毁本教程创建的所有资源，避免产生额外费用：

```bash
cd $ROOT_DIR/terraform
terraform destroy
```
