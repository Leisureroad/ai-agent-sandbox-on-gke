# Deploy Secure AI Agent Sandbox on GKE

This guide walks you through deploying the dynamic `agent-sandbox` controller, building the sandbox router, and running tests. It assumes you have already run the Terraform infrastructure provisioning step in the main guide.
# Deploy AI Agent Sandbox and Test

## Deploy the Filestore PVC and Sandbox Templates

```bash
echo "💿 Deploying Storage and Sandbox Templates..."
kubectl apply -f $ROOT_DIR/sandbox/storageclass.yaml
kubectl apply -f $ROOT_DIR/sandbox/kata/sandboxtemplate-kata.yaml
kubectl apply -f $ROOT_DIR/sandbox/gvisor/sandboxtemplate-gvisor.yaml
```

## Testing the Sandbox

Once the infrastructure is deployed, you can test the secure sandbox isolation and creation performance using test script `sandboxclient.py`.

### 1. Install Client Dependencies

```bash
# Create a virtual environment (Recommended)
python3 -m venv venv
source venv/bin/activate

# Install the agentic-sandbox-client and its dependencies
pip install k8s-agent-sandbox==0.2.1
```

### 2. Configure Local Authentication

Make sure your local environment has authenticated access to proxy the Kubernetes Gateway API requests, since the Python client will proxy commands into the cluster.

```bash
# Authenticate your default credentials and gcloud identity
gcloud auth login
gcloud auth application-default login
gcloud container clusters get-credentials ai-sandbox-cluster --region us-central1 --project <YOUR_PROJECT_ID>
```

### 3. Run the Client Test

Execute your testing script. This will use a `ThreadPoolExecutor` to spin up parallel sandbox claims and verify their isolation using the `df -Th` command inside the container and test the sandbox cold start lantency.

```bash
# execute gvisor sandbox test
python $ROOT_DIR/sandbox/gvisor/sandboxclient-gvisor.py

# execute kata sandbox test
python $ROOT_DIR/sandbox/kata/sandboxclient-kata.py
```

**Expected Output**:
You will see logging indicating the time taken to claim and initialize the sandboxes, followed by the storage mounted (including the `/data` Filestore mount) outputted from the `df -Th` execution securely within the `kata-clh` hypervisor. This verifies that your replicas warm pool gracefully handles immediate concurrent requests.
