# One-Click Deployment Solution for Hosted OpenClaw on GKE

This guide provides a consolidated, seamless process to deploy a secure and isolated AI Sandbox environment on Google Kubernetes Engine (GKE).

# Deploy OpenClaw
```bash
kubectl apply -f deployment-openclaw.yaml
kubectl exec -it <pod> -- sh

openclaw configure
openclaw tui
openclaw devices list
openclaw devices approve <request ID>

```
