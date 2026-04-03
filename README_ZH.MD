## 🔥 一键式 OpenClaw 部署 (热门)

> **生产级且全自动化**：这是部署包括基础设施和应用在内的整个解决方案的最快方式。

### 1. 配置环境和 IAM 权限
运行以下脚本以为服务账号授予必要的权限：

```bash
# 自动获取项目信息
export PROJECT_ID=<YOUR_PROJECT_ID>

# 设置项目并启用必要的 API
gcloud config set project $PROJECT_ID
gcloud services enable cloudresourcemanager.googleapis.com container.googleapis.com servicenetworking.googleapis.com cloudbuild.googleapis.com compute.googleapis.com file.googleapis.com

export PROJECT_NUMBER=$(gcloud projects list --filter="projectId:$PROJECT_ID" --format="value(projectNumber)")
export REGION="us-central1"
export ZONE="us-central1-a"

# 为 Compute 服务账号授予必要角色（用于基础设施/GKE 管理）
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/editor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/container.admin"
```

### 确保组织策略 compute.disableNestedVirtualization 已关闭 (可选)
```bash
# 生成带有变量扩展的策略文件
cat <<EOF > policy.yaml
name: projects/$PROJECT_ID/policies/compute.disableNestedVirtualization
spec:
  inheritFromParent: false
  rules:
  - enforce: false
EOF

gcloud org-policies set-policy policy.yaml
```

### 2. 运行部署
```bash
# 克隆仓库并部署
git clone https://github.com/Leisureroad/ai-agent-sandbox-on-gke.git
cd ai-agent-sandbox-on-gke

gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_REGION="$REGION",_ZONE="$ZONE"
gcloud container clusters get-credentials ai-sandbox-cluster --region $REGION --project $PROJECT_ID
kubectl port-forward pod/openclaw-sandbox 18789:18789
```

### 3. 访问 Web UI：在浏览器中打开 http://localhost:18789。

### 4. OpenClaw 命令行界面 (CLI)
您可以直接在沙箱容器内运行 OpenClaw CLI 命令。
```bash
kubectl exec -it openclaw-sandbox -- openclaw --help
```