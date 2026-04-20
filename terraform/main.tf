terraform {
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project     = var.project_id
  region      = var.region
}

# 0. Create Remote Artifact Registry for GHCR
resource "google_artifact_registry_repository" "ghcr_remote" {
  provider      = google-beta
  location      = var.region
  repository_id = "ghcr"
  description   = "Remote repository proxy for ghcr.io"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"

  remote_repository_config {
    docker_repository {
      custom_repository {
        uri = "https://ghcr.io"
      }
    }
  }
}

# 0.1 Create Remote Artifact Registry for Docker Hub
resource "google_artifact_registry_repository" "dockerhub_remote" {
  provider      = google-beta
  location      = var.region
  repository_id = "dockerhub"
  description   = "Remote repository proxy for docker.io"
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"

  remote_repository_config {
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }
}

# 1. Create the VPC Network
resource "google_compute_network" "sandbox_network" {
  name                    = "sandbox-network"
  auto_create_subnetworks = false
  description             = "VPC Network for AI Sandbox"
}

resource "google_compute_subnetwork" "sandbox_subnet" {
  name          = "sandbox-subnet"
  ip_cidr_range = "10.0.0.0/16"
  region        = var.region
  network       = google_compute_network.sandbox_network.id

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.1.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.2.0.0/20"
  }
}

# 1.5 Create Cloud NAT for Private Cluster
resource "google_compute_router" "router" {
  name    = "sandbox-router"
  region  = var.region
  network = google_compute_network.sandbox_network.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "sandbox-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# 2. Create the GKE Cluster
resource "google_container_cluster" "sandbox_cluster" {
  name                = var.cluster_name
  location            = var.region
  deletion_protection = false

  # Remove the default node pool to use our explicitly defined one
  remove_default_node_pool = true
  initial_node_count       = 1

  network    = google_compute_network.sandbox_network.name
  subnetwork = google_compute_subnetwork.sandbox_subnet.name

  # Enable Shielded VM for the temporary default pool to bypass org-policy check
  node_config {
    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }
    gcfs_config {
      enabled = true
    }
  }

  # Network configuration using secondary IP ranges
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Enable Workload Identity (Best Practice & often required for secure sandboxing)
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # Enable the Gateway API (Needed for external-http-gateway)
  gateway_api_config {
    channel = "CHANNEL_STANDARD"
  }

  # Enable Add-ons like Filestore CSI driver (Needed for persistent data volumes)
  addons_config {
    gcp_filestore_csi_driver_config {
      enabled = true
    }

    gcs_fuse_csi_driver_config {
      enabled = true
    }

    pod_snapshot_config {
      enabled = true
    }
  }


  provider = google-beta

  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }
}

# 3. Create the Node Pool for Kata Containers
resource "google_container_node_pool" "kata_nodepool" {
  name       = "kata-nodepool"
  # Using the cluster region/location
  location       = var.region
  node_locations = [var.zone]
  cluster        = google_container_cluster.sandbox_cluster.name
  node_count     = 3

  node_config {
    # N2 standard is recommended because it supports nested virtualization
    machine_type = "n2-standard-4"
    image_type   = "UBUNTU_CONTAINERD" # Ubuntu gives better default support for nested virtualization / Kata

    # Essential for kata-qemu runtime
    advanced_machine_features {
      enable_nested_virtualization = true
      threads_per_core             = 2
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    gcfs_config {
      enabled = true
    }

    # Used for ensuring scheduling to this specific pool
    labels = {
      "sandbox-node" = "true"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# 4. Create the Node Pool for gVisor Containers
resource "google_container_node_pool" "gvisor_nodepool" {
  name       = "gvisor-nodepool"
  location       = var.region
  node_locations = [var.zone]
  cluster        = google_container_cluster.sandbox_cluster.name
  node_count     = 3

  node_config {
    # Standard e2 machines are efficient for gVisor
    machine_type = "e2-standard-4"
    image_type   = "COS_CONTAINERD"

    # Enables native GKE Sandbox (gVisor)
    sandbox_config {
      type = "GVISOR"
    }

    shielded_instance_config {
      enable_secure_boot          = true
      enable_integrity_monitoring = true
    }

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    gcfs_config {
      enabled = true
    }

    labels = {
      "sandbox-node" = "gvisor"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# 5. Cleanup orphaned NEGs on destroy to prevent VPC deletion hangs
resource "null_resource" "cleanup_neg_on_destroy" {
  # 绑定到 VPC 生命周期
  triggers = {
    network_name = google_compute_network.sandbox_network.name
  }

  provisioner "local-exec" {
    when    = destroy
    # 在销毁时，利用 gcloud 查找挂在这个 network 下的所有 NEG 并强行删除
    command = <<EOT
      echo "Cleaning up orphaned NEGs..."
      gcloud compute network-endpoint-groups list \
        --filter="network:${self.triggers.network_name}" \
        --format="value(name,zone)" | \
      while read name zone; do
        if [ ! -z "$name" ]; then
          echo "Deleting NEG $name in zone $zone"
          gcloud compute network-endpoint-groups delete $name --zone=$zone --quiet || true
        fi
      done
    EOT
  }

  depends_on = [google_container_cluster.sandbox_cluster]
}

# 6. Workload Identity Configuration for Vertex AI
resource "google_service_account" "vertex_ai_client" {
  account_id   = "vertex-ai-client"
  display_name = "Vertex AI Client Service Account"
}

resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.vertex_ai_client.email}"
}

resource "google_service_account_iam_member" "workload_identity_user" {
  service_account_id = google_service_account.vertex_ai_client.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[default/gemini-app-sa]"

  # Ensure the cluster's workload identity pool is ready
  depends_on = [google_container_cluster.sandbox_cluster]
}

# 7. Pod Snapshot Infrastructure
resource "google_storage_bucket" "pod_snapshot_bucket" {
  name                        = "${var.project_id}-sandbox-pod-snapshot"
  location                    = var.region
  uniform_bucket_level_access = true
  
  # Required for GKE Pod Snapshots
  hierarchical_namespace {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  force_destroy = true
}

# Custom IAM role for Pod Snapshots
resource "google_project_iam_custom_role" "pod_snapshot_role" {
  role_id     = "podSnapshotGcsReadWriter"
  title       = "Pod Snapshot GCS Read/Writer"
  description = "Minimal permissions for GKE Pod snapshots"
  permissions = [
    "storage.objects.get",
    "storage.objects.create",
    "storage.objects.delete",
    "storage.folders.create"
  ]
}

# Grant GKE Controller (Robot SA) permission with condition
data "google_project" "project" {}

resource "google_project_iam_member" "gke_robot_snapshot_access" {
  project = var.project_id
  role    = "roles/storage.objectUser"
  member  = "serviceAccount:service-${data.google_project.project.number}@container-engine-robot.iam.gserviceaccount.com"

  condition {
    title       = "restrict_to_bucket"
    description = "Restricts access to the specific pod snapshot bucket"
    expression  = "resource.name == \"projects/_/buckets/${google_storage_bucket.pod_snapshot_bucket.name}\""
  }
}

# Grant default KSA access to the bucket via Workload Identity
resource "google_storage_bucket_iam_member" "ksa_bucket_viewer" {
  bucket = google_storage_bucket.pod_snapshot_bucket.name
  role   = "roles/storage.bucketViewer"
  member = "principal://iam.googleapis.com/projects/${data.google_project.project.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/default/sa/default"

  depends_on = [google_container_cluster.sandbox_cluster]
}

resource "google_storage_bucket_iam_member" "ksa_object_user" {
  bucket = google_storage_bucket.pod_snapshot_bucket.name
  role   = "roles/storage.objectUser"
  member = "principal://iam.googleapis.com/projects/${data.google_project.project.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/default/sa/default"

  depends_on = [google_container_cluster.sandbox_cluster]
}

# Create managed folder for snapshots
resource "google_storage_managed_folder" "snapshot_folder" {
  bucket = google_storage_bucket.pod_snapshot_bucket.name
  name   = "snapshots/"
}

# Grant KSA access to the managed folder
resource "google_storage_managed_folder_iam_member" "ksa_folder_access" {
  bucket         = google_storage_bucket.pod_snapshot_bucket.name
  managed_folder = google_storage_managed_folder.snapshot_folder.name
  role           = google_project_iam_custom_role.pod_snapshot_role.name
  member         = "principal://iam.googleapis.com/projects/${data.google_project.project.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/default/sa/default"

  depends_on = [google_container_cluster.sandbox_cluster]
}

# 8. GCS bucket for Sandbox
resource "google_storage_bucket" "sandbox_bucket" {
  name                        = "${var.project_id}-sandbox-bucket"
  location                    = var.region
  uniform_bucket_level_access = true
  
  # Required for GKE Pod Snapshots
  hierarchical_namespace {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  force_destroy = true
}

output "pod_snapshot_bucket_name" {
  value = google_storage_bucket.pod_snapshot_bucket.name
}
