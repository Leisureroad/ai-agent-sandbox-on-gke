# Hosted OpenClaw Deployment Solution on GKE

This guide provides a consolidated, seamless process to deploy a secure and isolated AI Sandbox environment on Google Kubernetes Engine (GKE).

## Deploy OpenClaw
```bash
kubectl apply -f deployment-gvisor.yaml
kubectl apply -f deployment-kata.yaml
kubectl exec -it <pod> -- sh

openclaw configure
openclaw tui
openclaw devices list
openclaw devices approve <request ID>

```
## Next
1. Please refer to [configure-feishu.MD](./configure-feishu.MD) to configure feishu.
2. Please refer to [podsnapshot.MD](./podsnapshot.MD) to enable GKE pod snapshot.