# AI Agent Sandbox Deployment Solution on GKE

This guide provides a consolidated, seamless process to deploy a secure and isolated AI Sandbox environment on Google Kubernetes Engine (GKE).

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Infrastructure Provisioning via Terraform](#infrastructure-provisioning-via-terraform)
3. [Deployment Scenarios](#deployment-scenarios)
4. [Build Sandbox Router & Deploy Gateway](#build-sandbox-router--deploy-gateway)
5. [Cleanup](#cleanup)

---

## Prerequisites

Before executing the deployment, ensure your local environment meets the following conditions:

- **Tools Installed**: `terraform`, `kubectl`, and `gcloud` CLIs are installed and authenticated.
- **Python Setup**: Python 3.10+ installed locally for testing the sandbox client.

```bash
# Set your environment variables
git clone https://github.com/Leisureroad/ai-agent-sandbox-on-gke.git
cd ai-agent-sandbox-on-gke
export ROOT_DIR=$(pwd)
export PROJECT_ID=<YOUR_PROJECT_ID>
export REGION=us-central1
export REPO_NAME=ai-sandbox-repo

# Enable required APIs
gcloud services enable cloudresourcemanager.googleapis.com container.googleapis.com servicenetworking.googleapis.com cloudbuild.googleapis.com compute.googleapis.com filestore.googleapis.com
```

---

## Infrastructure Provisioning via Terraform

Instead of manually creating a cluster from the UI, we've provided a Terraform manifest inside the `terraform/` directory. This script performs the following critical configurations out-of-the-box:
- Provisions the required VPC for the Filestore integration.
- Enables **Filestore CSI Support** and sets up the **GKE Gateway API** control plane.
- Creates two dedicated node pools:
  - `kata-nodepool`: Optimized for **Kata Containers** (running `n2-standard` with *Nested Virtualization* enabled).
  - `gvisor-nodepool`: Configured to natively utilize the GKE Sandbox with **gVisor** (`sandbox_type = "gvisor"`).

### Run the Infrastructure Build

Navigate to the terraform directory, adjust your variables if necessary, and execute the build.

```bash
# Initialize the Terraform workspace
cd $ROOT_DIR/terraform
terraform init

# Plan and Apply the infrastructure build
terraform apply -var="project_id=$PROJECT_ID"
```

Once Terraform completes its run, fetch the credentials so `kubectl` can route the application manifests:

```bash
# Fetch credentials for the newly created cluster
gcloud container clusters get-credentials ai-sandbox-cluster --region us-central1 --project <YOUR_PROJECT_ID>
```

```bash
# Install Kata Container Support
export VERSION=$(curl -sSL https://api.github.com/repos/kata-containers/kata-containers/releases/latest | jq .tag_name | tr -d '"')
export CHART="oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy"

helm install kata-deploy "${CHART}" --version "${VERSION}"

# See everything you can configure
helm show values "${CHART}" --version "${VERSION}"
```
---

## Deploy Agent Sandbox Controller & CRDs

```bash
# Deploy the Agent Sandbox Controller and Extensions
echo "📦 Deploying Agent Sandbox Controller & CRDs..."
kubectl apply \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.1.0/manifest.yaml \
  -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.1.0/extensions.yaml

# Wait for sandbox webhooks/controllers to be successfully established
echo "⏳ Waiting for Agent Sandbox Webhooks to become available..."
sleep 15
kubectl wait --for=condition=Ready=True pod --all -n agent-sandbox-system --timeout=120s  || true
```

## Deployment Scenarios

Now that your underlying GKE cluster and node pools are provisioned, you have two options for what to deploy:

### 1. Agent Sandbox on GKE

> [!IMPORTANT]
> ⚠️ **Prerequisite Step**: You must complete the [Build Sandbox Router & Deploy Gateway](#build-sandbox-router--deploy-gateway) section **before** you proceed with the following steps.

Deploy a massively scalable, isolated, multi-tenant execution environment where dynamic sandboxes are claimed on demand.

👉 **[Proceed to the Sandbox Deployment Guide](./sandbox/README.MD)**

### 2. Hosted OpenClaw on GKE
Deploy OpenClaw natively on highly isolated hardware (like Kata/gVisor), giving you a secure, permanent LLM Gateway and agent execution interface.

👉 **[Proceed to the OpenClaw Deployment Guide](./openclaw/README.MD)**

---

## Build Sandbox Router & Deploy Gateway

Before running the deployment script, you'll need to build and push the Sandbox Router Docker image to your container registry. The Sandbox Router acts as a central entry point for all sandbox traffic, routing requests dynamically to the correct sandbox.

### 1. Build the Sandbox Router Image

Before building the image, create an Artifact Registry repository to host it, and configure Docker to authenticate with the registry:

```bash
# Create the Artifact Registry repository
gcloud artifacts repositories create $REPO_NAME \
  --repository-format=docker \
  --location=$REGION \
  --description="Docker repository for AI Sandbox images"

# Authenticate Docker with Artifact Registry
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# Navigate to the Sandbox Router source directory
cd $ROOT_DIR
git clone https://github.com/kubernetes-sigs/agent-sandbox.git
cd agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/

# Build and push the image using Cloud Build
export SANDBOX_ROUTER_IMG=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/sandbox-router:latest
gcloud builds submit --tag $SANDBOX_ROUTER_IMG .
```

### 2. Deploy the Sandbox Router and Gateway

Save the following routine as a deployment script (e.g., `deploy.sh`), or directly copy and run it in your terminal. This script will automatically install the sandbox infrastructure, set up persistent volumes via Filestore, establish the network sandbox router and gateway, and prepare the warm pool instances.

```bash
# Deploy the Sandbox Router and Gateway
echo "🔄 Deploying Sandbox Router..."
sed -i "" "s|IMAGE_PLACEHOLDER|${SANDBOX_ROUTER_IMG}|g" "$ROOT_DIR/agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml"
kubectl apply -f $ROOT_DIR/agent-sandbox/clients/python/agentic-sandbox-client/sandbox-router/sandbox_router.yaml

echo "🌐 Deploying Gateway Networking (gateway.yaml)..."
kubectl apply -f $ROOT_DIR/sandbox/gateway.yaml

```

---

## Cleanup

To remove all the resources created during this tutorial and avoid any billing charges, run the following cleanup commands:

```bash
cd $ROOT_DIR/terraform
terraform destroy
```

