# Hosted OpenClaw Deployment Solution on GKE

This guide provides a consolidated, seamless process to deploy a secure and isolated AI Sandbox environment on Google Kubernetes Engine (GKE).

## Deploy OpenClaw
```bash
# you need to update your GEMINI API KEY and pod snapshot name in deployment-gvisor.yaml before you deploy it.
kubectl apply -f deployment-gvisor.yaml

# you need to update your GEMINI API KEY in deployment-kata.yaml before you deploy it.
kubectl apply -f deployment-kata.yaml
kubectl exec -it <pod> -- sh

openclaw devices list

# sample:
Direct scope access failed; using local fallback.
Pending (1)
┌──────────────────────────────────────┬───────────────────────────────────────┬──────────┬──────────────────────────────────────────────────────────┬────────────┬──────────┬────────┐
│ Request                              │ Device                                │ Role     │ Scopes                                                   │ IP         │ Age      │ Flags  │
├──────────────────────────────────────┼───────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────┼────────────┼──────────┼────────┤
│ 8f2e4b4d-836c-4a27-a0e3-d558a7fd4ffb │ a3dff1ee9cf6b9dafad9cd3e1d3ee76deb7e9 │ operator │ operator.admin, operator.read, operator.write, operator. │            │ just now │        │
│                                      │ 4787d32840395c6841d5352b6a6           │          │ approvals, operator.pairing                              │            │          │        │
└──────────────────────────────────────┴───────────────────────────────────────┴──────────┴──────────────────────────────────────────────────────────┴────────────┴──────────┴────────┘

openclaw devices approve 8f2e4b4d-836c-4a27-a0e3-d558a7fd4ffb

openclaw tui


```
## Next
1. Please refer to [configure-feishu.MD](./configure-feishu.MD) to configure feishu.
2. Please refer to [podsnapshot.MD](./podsnapshot.MD) to enable GKE pod snapshot.