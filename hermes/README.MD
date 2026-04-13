# Hermes Agent on GKE 🏛️

Hermes is an **open-source, self-improving AI agent** developed by Nous Research, designed to "grow with you." Unlike conventional tools, Hermes builds **persistent memory**, creates **reusable skills** from experience, and refines its capabilities over time through a **closed learning loop**.

## 🌟 Solution Highlights
- **Full-featured UI**: Manage agents, tools, and conversations.
- **Vertex AI Native**: Deeply integrated with Google's Gemini models.
- **Automated Lifecycle**: Powered by Cloud Build for reliable, repeatable deployments.
- **Local-First & Private**: Self-hosted on your GKE infrastructure for maximum data privacy.
- **Lightweight & Efficient**: Minimal resource footprint (500Mi RAM), perfect for cost-sensitive deployments.

---

## 🔥 One-Click Hermes Deployment

You can now deploy Hermes using the dedicated configuration within this directory.

```bash
# Get project info automatically
export PROJECT_ID=<YOUR_PROJECT_ID>

# Set project and enable required APIs
gcloud config set project $PROJECT_ID
gcloud services enable cloudresourcemanager.googleapis.com container.googleapis.com servicenetworking.googleapis.com cloudbuild.googleapis.com compute.googleapis.com file.googleapis.com aiplatform.googleapis.com

export PROJECT_NUMBER=$(gcloud projects list --filter="projectId:$PROJECT_ID" --format="value(projectNumber)")
export REGION="us-central1"
export ZONE="us-central1-a"

# Grant necessary roles to the Compute account (required for Infrastructure/GKE management)
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

### Ensure Organization Policy compute.disableNestedVirtualization is Off (Optional)
```bash
# Generate the policy file with variable expansion
cat <<EOF > policy.yaml
name: projects/$PROJECT_ID/policies/compute.disableNestedVirtualization
spec:
  inheritFromParent: false
  rules:
  - enforce: false
EOF

gcloud org-policies set-policy policy.yaml
```

### 2. Run the Deployment
```bash
# Clone and Deploy
git clone https://github.com/Leisureroad/ai-agent-sandbox-on-gke.git
cd ai-agent-sandbox-on-gke

gcloud builds submit --config ./hermes/cloudbuild.yaml \
  --substitutions=_REGION="$REGION",_ZONE="$ZONE"

```

### 3. Verification
Verify that the Hermes deployment is successful by checking the Pod status.

### 4. Hermes CLI
You can run Hermes CLI commands directly inside the sandbox container.
```bash
kubectl exec -it hermes-sandbox-gvisor -- hermes setup
kubectl exec -it hermes-sandbox-gvisor -- hermes gateway run
kubectl exec -it hermes-sandbox-gvisor -- hermes pairing list
kubectl exec -it hermes-sandbox-gvisor -- hermes chat
```

### 5. Verify Pod Snapshot
```bash
kubectl apply -f - <<EOF
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotManualTrigger
metadata:
  name: example-manual-trigger
spec:
  targetPod: hermes-sandbox-gvisor
EOF


# kill hermes pod
kubectl delete pod hermes-sandbox-gvisor

# wait for the pod to be recreated
kubectl wait --for=condition=ready pod hermes-sandbox-gvisor --timeout=5m

# check the pod snapshotting status
kubectl describe pod hermes-sandbox-gvisor

Events:
  Type    Reason              Age   From               Message
  ----    ------              ----  ----               -------
  Normal  Scheduled           50s   default-scheduler  Successfully assigned default/hermes-sandbox-gvisor to gke-ai-sandbox-cluste-gvisor-nodepool-dce8fbc3-t702
  Normal  Pulling             48s   kubelet            spec.initContainers{init-config}: Pulling image "busybox:latest"
  Normal  Pulled              48s   kubelet            spec.initContainers{init-config}: Successfully pulled image "busybox:latest" in 177ms (177ms including waiting). Image size: 2222002 bytes.
  Normal  Created             48s   kubelet            spec.initContainers{init-config}: Container created
  Normal  Started             45s   kubelet            spec.initContainers{init-config}: Container started
  Normal  Pulled              43s   kubelet            spec.containers{hermes}: Container image "us-central1-docker.pkg.dev/flius-test-18/dockerhub/nousresearch/hermes-agent" already present on machine and can be accessed by the pod
  Normal  Created             43s   kubelet            spec.containers{hermes}: Container created
  Normal  GKEPodSnapshotting  42s   gke-pod-snapshots  Successfully restored the pod from PodSnapshot default/375062cb-ed8b-409f-902c-04adfc95a6e2
  Normal  Started             42s   kubelet            spec.containers{hermes}: Container started
```

### 6. Hermes Resource Usage

Hermes is highly optimized for low-resource environments. Based on actual GKE monitoring metrics:

- **Memory Efficiency**: Average RAM consumption stays around **~200MiB**, which is significantly lower than most agentic frameworks. This allows for high-density multi-tenant hosting.
- **CPU Profile**: Idle CPU usage is near zero, with efficient bursts during task execution that stay well within the **1.0 core** limit.
- **Scale-to-Zero Compatibility**: Due to its small footprint, Hermes can be rapidly hibernated or restored using Pod Snapshots without heavy hardware overhead.

![Hermes Resource Usage Analysis](./Screenshot.png)
