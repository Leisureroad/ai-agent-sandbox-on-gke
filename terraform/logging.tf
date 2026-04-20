###############################################################################
# Hermes Agent Logging -- Alerts, Dashboard, and Log Routing
###############################################################################

resource "google_project_service" "monitoring_api" {
  project            = var.project_id
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false

  # Ensure core infrastructure is ready before enabling monitoring/logging
  depends_on = [
    google_container_cluster.sandbox_cluster,
    google_container_node_pool.kata_nodepool,
    google_container_node_pool.gvisor_nodepool,
    google_storage_managed_folder_iam_member.ksa_folder_access
  ]
}

# ──────────────────────────────────────────────────────────────────────────────
# Notification Channel
# ──────────────────────────────────────────────────────────────────────────────

resource "google_monitoring_notification_channel" "hermes_email" {
  count = var.alert_email != "" ? 1 : 0

  display_name = "Hermes Agent Alerts"
  type         = "email"
  project      = var.project_id

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.monitoring_api]
}

# ──────────────────────────────────────────────────────────────────────────────
# Log-Based Alerts
# ──────────────────────────────────────────────────────────────────────────────

# Alert: Hermes pod crash / restart
resource "google_logging_metric" "hermes_crash" {
  name    = "hermes/pod_restart"
  project = var.project_id
  filter  = <<-EOT
    resource.type="k8s_container"
    resource.labels.container_name="hermes-sandbox-gvisor"
    jsonPayload.reason="BackOff" OR textPayload=~"CrashLoopBackOff"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "hermes_crash" {
  count = var.alert_email != "" ? 1 : 0

  display_name = "Hermes Agent: Pod CrashLoop"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "Hermes pod in CrashLoopBackOff"

    condition_threshold {
      filter          = "resource.type = \"k8s_container\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.hermes_crash.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.hermes_email[0].name]

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "A Hermes Agent pod is crash-looping. Check `kubectl logs` for details. Common causes: config errors or OOM."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.monitoring_api]
}

# ──────────────────────────────────────────────────────────────────────────────
# Log Storage -- GCS Bucket Sink
# ──────────────────────────────────────────────────────────────────────────────

resource "google_storage_bucket" "hermes_logs" {
  name          = "${var.project_id}-hermes-logs"
  location      = var.region
  project       = var.project_id
  force_destroy = false

  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  labels = var.labels
}

resource "google_project_service" "logging_api" {
  project            = var.project_id
  service            = "logging.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service_identity" "logging_identity" {
  provider = google-beta
  project  = var.project_id
  service  = "logging.googleapis.com"
  depends_on = [google_project_service.logging_api]
}

resource "google_logging_project_sink" "hermes_gcs" {
  name        = "hermes-logs-to-gcs"
  project     = var.project_id
  destination = "storage.googleapis.com/${google_storage_bucket.hermes_logs.name}"

  filter = <<-EOT
    resource.type="k8s_container" AND resource.labels.namespace_name="hermes"
  EOT

  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "log_sink_writer" {
  bucket = google_storage_bucket.hermes_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.hermes_gcs.writer_identity

  # Ensure the logging identity exists in IAM before granting permissions
  depends_on = [google_project_service_identity.logging_identity]
}

# ──────────────────────────────────────────────────────────────────────────────
# Dashboard
# ──────────────────────────────────────────────────────────────────────────────

resource "google_monitoring_dashboard" "hermes" {
  project        = var.project_id
  dashboard_json = jsonencode({
    displayName = "Hermes Agent Operations"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          xPos   = 0
          yPos   = 0
          width  = 12
          height = 4
          widget = {
            title = "Hermes Agent Logs (all developers)"
            logsPanel = {
              filter = <<-EOT
                resource.type="k8s_container"
                resource.labels.container_name="hermes-sandbox-gvisor"
              EOT
            }
          }
        },
        {
          xPos   = 0
          yPos   = 4
          width  = 12
          height = 4
          widget = {
            title = "Pod Restarts"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type = \"k8s_container\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.hermes_crash.name}\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_SUM"
                    }
                  }
                }
              }]
              timeshiftDuration = "0s"
              yAxis = { scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 0
          yPos   = 8
          width  = 12
          height = 4
          widget = {
            title = "Hermes Errors Only"
            logsPanel = {
              filter = <<-EOT
                resource.type="k8s_container"
                resource.labels.container_name="hermes-sandbox-gvisor"
                severity>="ERROR"
              EOT
            }
          }
        }
      ]
    }
  })

  depends_on = [google_project_service.monitoring_api]
}