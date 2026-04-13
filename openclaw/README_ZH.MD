# GKE 上的 OpenClaw Agent 🏛️

OpenClaw 是一款 **开源、私有化部署的自主 AI 代理**，旨在作为一个 **代理式接口 (Agentic Interface)** 代表您直接执行操作。与标准聊天机器人不同，OpenClaw 可以执行 Shell 命令、管理文件并自动化 Web 任务，作为一个持久且始终在线的个人助理。

## 🌟 方案亮点
- **功能完备的 UI**: 管理代理、工具及对话。
- **Vertex AI 原生支持**: 深度集成 Google Gemini 系列模型。
- **自动化生命周期**: 结合 Cloud Build 实现可靠、可重复的部署。
- **本地优先与隐私**: 私有化部署于 GKE 基础设施，确保最高级别的数据隐私。

---

## 🔥 OpenClaw 一键部署 (HOT)

您现在可以使用此目录下的专用配置部署 OpenClaw。

```bash
# 自动获取项目信息
export PROJECT_ID=<您的项目 ID>

# 设置项目并启用必要的 API
gcloud config set project $PROJECT_ID
gcloud services enable cloudresourcemanager.googleapis.com container.googleapis.com servicenetworking.googleapis.com cloudbuild.googleapis.com compute.googleapis.com file.googleapis.com aiplatform.googleapis.com

export PROJECT_NUMBER=$(gcloud projects list --filter="projectId:$PROJECT_ID" --format="value(projectNumber)")
export REGION="us-central1"
export ZONE="us-central1-a"

# 为 Compute 账号授予必要权限（基础设施/GKE 管理所需）
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/editor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/container.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/iam.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
    --role="roles/resourcemanager.projectIamAdmin"
```

### 确保组织策略 compute.disableNestedVirtualization 已关闭（可选）
```bash
# 生成包含变量扩展的策略文件
cat <<EOF > policy.yaml
name: projects/$PROJECT_ID/policies/compute.disableNestedVirtualization
spec:
  inheritFromParent: false
  rules:
  - enforce: false
EOF

gcloud org-policies set-policy policy.yaml
```

### 2. 执行部署
```bash
# 克隆仓库并部署
git clone https://github.com/Leisureroad/ai-agent-sandbox-on-gke.git
cd ai-agent-sandbox-on-gke

gcloud builds submit --config ./openclaw/cloudbuild.yaml \
  --substitutions=_REGION="$REGION",_ZONE="$ZONE"
  
gcloud container clusters get-credentials ai-sandbox-cluster --region $REGION --project $PROJECT_ID
kubectl port-forward pod/openclaw-sandbox 18789:18789
```

### 3. 访问 Web UI: 在浏览器中打开 http://localhost:18789。

### 4. Openclaw 命令行工具
您可以直接在沙箱容器内运行 OpenClaw CLI 命令。
```bash
kubectl exec -it openclaw-sandbox -- openclaw --help
```


### 5. 验证 Pod 快照 (Pod Snapshot)
```bash
# 手动触发快照
kubectl apply -f - <<EOF
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotManualTrigger
metadata:
  name: example-manual-trigger
spec:
  targetPod: openclaw-sandbox-gvisor
EOF

# 彻底删除 openclaw pod
kubectl delete pod openclaw-sandbox-gvisor

# 等待 pod 重新创建（从快照恢复）
kubectl wait --for=condition=ready pod openclaw-sandbox-gvisor --timeout=5m

# 检查 Pod 快照恢复状态
kubectl describe pod openclaw-sandbox-gvisor

输出示例：
Events:
  Type    Reason              Age   From               Message
  ----    ------              ----  ----               -------
  Normal  Scheduled           34s   default-scheduler  Successfully assigned default/openclaw-sandbox-gvisor to gke-ai-sandbox-cluste-gvisor...
  Normal  Pulled              31s   kubelet            spec.containers{openclaw}: Container image "us-central1-docker.pkg.dev/.../openclaw/openclaw" already present...
  Normal  Created             31s   kubelet            spec.containers{openclaw}: Container created
  Normal  GKEPodSnapshotting  28s   gke-pod-snapshots  Successfully restored the pod from PodSnapshot default/9d0ec38b-f6ae-4f87-927a-aac461c61f9d
  Normal  Started             28s   kubelet            spec.containers{openclaw}: Container started
```

### 6. OpenClaw 资源占用分析
![OpenClaw 资源占用分析](./Screenshot.png)
