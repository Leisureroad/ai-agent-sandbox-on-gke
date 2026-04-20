variable "project_id" {
  description = "The Google Cloud Project ID"
  type        = string
}

variable "region" {
  description = "The compute region (e.g. us-central1)"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "The compute zone for the node pool (e.g. us-central1-a)"
  type        = string
  default     = "us-central1-a"
}

variable "cluster_name" {
  description = "Name of the GKE cluster"
  type        = string
  default     = "ai-sandbox-cluster"
}

variable "alert_email" {
  description = "Email address for monitoring alerts. Leave empty to disable alerts."
  type        = string
  default     = "youremail@example.com"
}

variable "labels" {
  description = "Common labels to apply to all resources"
  type        = map(string)
  default     = {}
}
