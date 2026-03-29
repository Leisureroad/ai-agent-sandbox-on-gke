output "cluster_name" {
  description = "The name of the GKE cluster"
  value       = google_container_cluster.sandbox_cluster.name
}

output "cluster_endpoint" {
  description = "The IP address of this cluster's Kubernetes master."
  value       = google_container_cluster.sandbox_cluster.endpoint
}

output "network_name" {
  description = "The name of the VPC network."
  value       = google_compute_network.sandbox_network.name
}
