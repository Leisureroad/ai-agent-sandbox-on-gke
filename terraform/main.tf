provider "google" {
  project = var.project_id
  region  = var.region
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

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
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

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    workload_metadata_config {
      mode = "GKE_METADATA"
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
