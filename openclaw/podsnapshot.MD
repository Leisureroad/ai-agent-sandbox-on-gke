# GKE pod snapshot

## Enable Pod Snapshot
```bash
gcloud beta container clusters update ai-sandbox-cluster \
   --enable-pod-snapshots \
   --location=us-central1
```

## Create a Cloud Storage bucket
```bash
gcloud storage buckets create "gs://sandbox-pod-snapshot-${PROJECT_ID}" \
   --uniform-bucket-level-access \
   --enable-hierarchical-namespace \
   --soft-delete-duration=0d \
   --location="LOCATION"
```

## Grant the KSA permission to access the bucket
```bash
gcloud storage buckets add-iam-policy-binding "gs://sandbox-pod-snapshot-${PROJECT_ID}" \
    --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/subject/ns/default/sa/default" \
    --role="roles/storage.bucketViewer"

gcloud storage buckets add-iam-policy-binding "gs://sandbox-pod-snapshot-${PROJECT_ID}" \
    --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/subject/ns/default/sa/default" \
    --role="roles/storage.objectUser"
```

## Grant controller permission to access the Cloud Storage bucket
```bash
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@container-engine-robot.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser" \
  --condition="expression=resource.name == \"projects/_/buckets/sandbox-pod-snapshot-${PROJECT_ID}"\",title=restrict_to_bucket,description=Restricts access to one bucket only"
```

## (Optional) Create managed folders for the Cloud Storage bucket
```bash
# Create a custom IAM role that contains only the necessary permissions for Pod snapshots
gcloud iam roles create podSnapshotGcsReadWriter \
    --project="${PROJECT_ID}" \
    --permissions="storage.objects.get,storage.objects.create,storage.objects.delete,storage.folders.create"

# Grant the roles/storage.bucketViewer role to all KSAs in the target namespace. 
gcloud storage buckets add-iam-policy-binding "gs://sandbox-pod-snapshot-${PROJECT_ID}" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/namespace/default" \
    --role="roles/storage.bucketViewer"
```

## Create a managed folder for the KSA
```bash
gcloud storage managed-folders create "gs://sandbox-pod-snapshot-${PROJECT_ID}/snapshots/"
```

## Grant the KSA the custom podSnapshotGcsReadWriter role on the managed folder
```bash
gcloud storage managed-folders add-iam-policy-binding "gs://sandbox-pod-snapshot-${PROJECT_ID}/snapshots/" \
    --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${PROJECT_ID}.svc.id.goog/subject/ns/default/sa/default" \
    --role="projects/${PROJECT_ID}/roles/podSnapshotGcsReadWriter"
```

## Configure storage for snapshots
```bash
kubectl apply -f - <<EOF
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotStorageConfig
metadata:
  name: example-pod-snapshot-storage-config
spec:
  snapshotStorageConfig:
    gcs:
      bucket: "sandbox-pod-snapshot-${PROJECT_ID}"
      path: "snapshots"
EOF
```
## Create a snapshot policy
```bash
kubectl apply -f - <<EOF
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotPolicy
metadata:
  name: example-pod-snapshot-policy
  namespace: default
spec:
  storageConfigName: example-pod-snapshot-storage-config
  selector:
    matchLabels:
      app: my-app
  triggerConfig:
    type: manual
    postCheckpoint: resume
EOF
```

## Trigger a snapshot manually
```bash
kubectl apply -f - <<EOF
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotManualTrigger
metadata:
  name: example-manual-trigger
spec:
  targetPod: <your pod name>
EOF
```

## Restore from a specific snapshot
```bash
# Add annotation in your pod spec.metadata
  annotations:
    podsnapshot.gke.io/ps-name: "<your snapshot name>"
```

## Restore snapshot events example
```bash
Events:
  Type    Reason                  Age   From                     Message
  ----    ------                  ----  ----                     -------
  Normal  Scheduled               73s   default-scheduler        Successfully assigned default/openclaw-gvisor-55cd6fc5b5-kvp2h to gke-ai-sandbox-cluste-gvisor-nodepool-687af7be-fb9j
  Normal  SuccessfulAttachVolume  69s   attachdetach-controller  AttachVolume.Attach succeeded for volume "pvc-6c0dcaa7-49d7-4660-aafd-ab0e4c6db2a3"
  Normal  Pulling                 61s   kubelet                  spec.initContainers{init-config}: Pulling image "busybox:latest"
  Normal  Pulled                  60s   kubelet                  spec.initContainers{init-config}: Successfully pulled image "busybox:latest" in 336ms (336ms including waiting). Image size: 2222002 bytes.
  Normal  Created                 60s   kubelet                  spec.initContainers{init-config}: Container created
  Normal  Started                 58s   kubelet                  spec.initContainers{init-config}: Container started
  Normal  Pulling                 55s   kubelet                  spec.containers{gateway}: Pulling image "ghcr.io/openclaw/openclaw"
  Normal  Pulled                  46s   kubelet                  spec.containers{gateway}: Successfully pulled image "ghcr.io/openclaw/openclaw" in 9.732s (9.732s including waiting). Image size: 1125545119 bytes.
  Normal  Created                 46s   kubelet                  spec.containers{gateway}: Container created
  Normal  GKEPodSnapshotting      45s   gke-pod-snapshots        Successfully restored the pod from PodSnapshot default/9e40de9a-70e4-4a1e-b8bd-dc47fab4f068
  Normal  Started                 45s   kubelet                  spec.containers{gateway}: Container started
  ```