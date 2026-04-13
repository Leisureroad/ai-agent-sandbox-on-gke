## Configure workload identity
### Define Variables
First, define the environment variables to make the commands reusable:

```bash
export PROJECT_ID="your-project-id"
export GSA_NAME="vertex-ai-client" # Google IAM Service Account name
export KSA_NAME="gemini-app-sa"     # Kubernetes Service Account name
export NAMESPACE="default"         # Namespace where your app resides
```

### Configure Google Service Account (GSA)
Create a GSA and grant it the necessary permissions to call the Vertex AI APIs.

```bash
# 1. Create the GSA
gcloud iam service-accounts create $GSA_NAME --project=$PROJECT_ID

# 2. Grant Vertex AI User role (Core role for Gemini API)
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$GSA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user"
```

### Configure Kubernetes Service Account (KSA) and Bindings
This is the core of Workload Identity: linking the KSA and GSA together.

```bash
# 1. Create the Kubernetes ServiceAccount
kubectl create serviceaccount $KSA_NAME --namespace $NAMESPACE

# 2. Allow the KSA to impersonate the GSA (IAM Binding)
gcloud iam service-accounts add-iam-policy-binding \
    $GSA_NAME@$PROJECT_ID.iam.gserviceaccount.com \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:$PROJECT_ID.svc.id.goog[$NAMESPACE/$KSA_NAME]"

# 3. Annotate the KSA to associate it with the GSA
kubectl annotate serviceaccount $KSA_NAME \
    --namespace $NAMESPACE \
    iam.gke.io/gcp-service-account=$GSA_NAME@$PROJECT_ID.iam.gserviceaccount.com
```