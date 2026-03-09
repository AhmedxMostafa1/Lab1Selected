# Engineering Report - AIOps Observability Lab 1

## 1. Objective

Build a Laravel API that emits ML-ready telemetry and exposes RED metrics for anomaly detection and incident triage. The experiment must inject a controlled anomaly window with machine-readable ground truth.

## 2. Telemetry Design

### 2.1 Log Schema

The telemetry record is intentionally stable and includes the same keys for every request:

- `timestamp`: event time in ISO-8601 for ordering and correlation with metrics.
- `request_id`: cross-service correlation key (`X-Request-Id` propagated/generated).
- `client_ip`, `user_agent`: source context for traffic profiling.
- `method`, `path`, `query`, `route_name`: request identity and route-level grouping.
- `payload_size_bytes`, `response_size_bytes`: payload pressure and bandwidth signals.
- `status_code`, `latency_ms`: core RED dimensions for response and performance.
- `severity`: quick triage level (`info` for normal, `error` for categorized failures).
- `error_category`: canonical class used by logs and metrics.
- `build_version`: release-aware debugging and regression isolation.
- `host`: node identity for multi-instance deployments.

The schema is intentionally fixed to simplify downstream ingestion and model training.

### 2.2 Error Categorization

Centralized in `app/Exceptions/Handler.php`:

- `VALIDATION_ERROR`: `ValidationException`
- `DATABASE_ERROR`: `QueryException`
- `SYSTEM_ERROR`: uncaught server-side failures
- `UNKNOWN`: other 4xx-class failures

Middleware applies latency-aware override:

- `TIMEOUT_ERROR` when request latency exceeds 4000 ms, even if status is 200.

This supports the lab requirement for "successful but unhealthy" requests (`/api/slow?hard=1`).

### 2.3 Correlation + Propagation

Middleware reads `X-Request-Id` when provided, otherwise generates UUID, and always writes it to the response header. This keeps request traces linkable across logs and clients.

## 3. Metrics Engineering

## 3.1 RED Metrics

Counters:

- `http_requests_total{method,path,status}`
- `http_errors_total{method,path,error_category}`

Histogram:

- `http_request_duration_seconds_bucket{method,path,le}`
- `http_request_duration_seconds_sum{method,path}`
- `http_request_duration_seconds_count{method,path}`

Buckets:

- `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf`

These buckets capture:

- fast responses (`/api/normal`)
- moderate delay (`/api/slow`)
- severe delay (`/api/slow?hard=1`)

## 3.2 Cardinality Controls

Metric labels are restricted to low-cardinality fields (`method`, normalized `path`, `status`, `error_category`). No request IDs or raw query strings are used as labels to avoid label explosion.

## 3.3 Metrics Exclusion

`/metrics` is excluded from logging and instrumentation to avoid self-generated noise and artificial request-rate inflation.

## 4. Monitoring Stack

Implemented artifacts:

- `docker-compose.yml` for Prometheus and Grafana
- `monitoring/prometheus/prometheus.yml` scrape config
- Grafana dashboard export with required panels:
  - RPS per endpoint
  - Error rate % per endpoint
  - P50/P95/P99 per endpoint
  - Stacked error category breakdown
  - Anomaly window marker

Anomaly marker signal:

- `aiops_anomaly_window` gauge (1 active, 0 inactive)

## 5. Controlled Anomaly Experiment

Traffic generator:

- `traffic_generator.py`
- base load 8-12 minutes
- exactly 2-minute anomaly window
- distribution aligned with lab specification
- produces:
  - `ground_truth.json`
  - `logs.json`
  - `traffic_run_summary.json`

Ground truth fields:

- `anomaly_start_iso`
- `anomaly_end_iso`
- `anomaly_type`
- `expected_behavior`

## 6. Why This Is ML-Ready

- Stable schema with explicit error taxonomy
- Correlation IDs for cross-event stitching
- Latency-aware timeout classification independent of status code
- RED metrics with quantile-ready histogram design
- Labeled anomaly window + machine-readable ground truth

This provides directly usable inputs for supervised anomaly detection and incident triage pipelines.

## 7. Validation Checklist

- Endpoint coverage includes normal/slow/error/random/db/validate.
- Validation and DB failures are separated (`VALIDATION_ERROR` vs `DATABASE_ERROR`).
- Timeout-over-200 behavior is captured (`TIMEOUT_ERROR` with `status_code=200`).
- Prometheus metrics include required counters and histogram.
- Grafana dashboard includes all required visibility panels.
- Generator exports ground truth and structured logs dataset.
