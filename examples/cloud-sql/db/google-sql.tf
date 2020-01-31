variable "gcp_region" {
  type        = "string"
  description = "The region where we'll create your resources (e.g. us-central1)."
  default     = "europe-west1"
}

variable "gcp_project_id" {
  type        = "string"
  description = "The project ID where we'll create the GKE cluster and related resources."
  # TODO: Use variable
  default     = "garden-gke-tf-eysi-265108"
}

variable "gcp_zone" {
  type        = "string"
  description = "The zone where we'll create your resources (e.g. us-central1-b)."
  default     = "europe-west1-b"
}

variable "gcp_network" {
  type        = "string"
  description = "The GCP network to use. Created in cluster/gke.tf"
  # TODO: Remove default
  default     = "https://www.googleapis.com/compute/v1/projects/garden-gke-tf-eysi-265108/global/networks/tf-gke-3"
}

provider "google-beta" {
  project = "${var.gcp_project_id}"
  region  = "${var.gcp_region}"
  zone    = "${var.gcp_zone}"
}

resource "google_compute_global_address" "private_ip_address" {
  provider = "google-beta"

  # NOTE: Bumped to 3
  name          = "private-ip-address-3"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = "${var.gcp_network}"
  # network       = google_compute_network.private_network.self_link
}

resource "google_service_networking_connection" "private_vpc_connection" {
  provider = "google-beta"

  network                 = "${var.gcp_network}"
  # network                 = google_compute_network.private_network.self_link
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = ["${google_compute_global_address.private_ip_address.name}"]
}

resource "random_id" "db_name_suffix" {
  byte_length = 4
}

resource "google_sql_database_instance" "instance" {
  provider = "google-beta"

  name              = "private-instance-${random_id.db_name_suffix.hex}"
  database_version  = "POSTGRES_11"
  region            = "${var.gcp_region}"

  # This works despite lint error
  depends_on = [google_service_networking_connection.private_vpc_connection]

  settings {
    tier = "db-f1-micro"
    ip_configuration {
      ipv4_enabled    = false
      private_network = "${var.gcp_network}"
      # private_network = google_compute_network.private_network.self_link
    }
  }
}

resource "google_sql_user" "users" {
  name     = "eysi"
  instance = "${google_sql_database_instance.instance.name}"
  password = "eysi1234"
  project  = "${var.gcp_project_id}"
}

output "db_host_ip" {
  value = "${google_sql_database_instance.instance.private_ip_address}"
}

output "db_username" {
  value = "${google_sql_user.users.name}"
}

output "db_password" {
  value = "${google_sql_user.users.password}"
}
