# AIOps Lab 1 (Laravel + Prometheus + Grafana)

This project is a Laravel 12 API instrumented for AIOps observability:

- Structured JSON logging to `storage/logs/aiops.log`
- RED metrics exposed on `/metrics` in Prometheus format
- Grafana dashboard for traffic/error/latency/anomaly visibility
- Controlled traffic generator with anomaly injection
- Dataset and ground-truth export (`logs.json`, `ground_truth.json`)
- Incident detection records in `storage/aiops/incidents.json`
- Incident response records in `storage/aiops/responses.json`

## 1. Project Structure

- `app/Http/Middleware/AIOpsTelemetry.php`: request telemetry middleware (log + metrics)
- `app/Exceptions/Handler.php`: centralized error categorization
- `app/Support/PrometheusMetrics.php`: in-process metric store + `/metrics` renderer
- `config/logging.php`: custom `aiops` JSON logging channel
- `config/aiops.php`: automation policies, paths, and escalation settings
- `routes/api.php`: API endpoints used by experiments
- `routes/web.php`: `/metrics` endpoint
- `bootstrap/app.php`: middleware and API route registration
- `app/Services/AIOpsDetectionEngine.php`: incident detection engine
- `app/Services/AIOpsAutomationEngine.php`: incident response automation engine
- `app/Console/Commands/AIOpsDetectCommand.php`: incident detection command
- `app/Console/Commands/AIOpsRespondCommand.php`: automation response command
- `docker-compose.yml`: Prometheus + Grafana stack
- `monitoring/prometheus/prometheus.yml`: Prometheus scrape config
- `monitoring/grafana/dashboards/aiops-red-dashboard.json`: Grafana dashboard export
- `traffic_generator.py`: controlled load + anomaly + dataset export
- `Engineering_Report.md`: report content ready for PDF export

## 2. What The System Does

For each request (except `/metrics`):

1. Propagates/creates `X-Request-Id`
2. Measures latency
3. Classifies errors (`NONE`, `VALIDATION_ERROR`, `DATABASE_ERROR`, `SYSTEM_ERROR`, `TIMEOUT_ERROR`, `UNKNOWN`)
4. Writes a strict JSON log record to `aiops.log`
5. Updates Prometheus metrics

`/metrics` is excluded from logging and instrumentation to avoid self-noise.

## 3. API Endpoints

All endpoints are under `/api`:

- `GET /api/normal`: healthy fast response
- `GET /api/random`: random mixed behavior (normal/slow/error)
- `GET /api/slow`: 100-500ms simulated slow response
- `GET /api/slow?hard=1`: 5-7s response (latency anomaly candidate)
- `GET /api/error`: forced HTTP 500
- `GET /api/db`: normal DB query (`SELECT 1`)
- `GET /api/db?fail=1`: forced DB exception
- `POST /api/validate`: validation endpoint
  - Valid payload example:
    - `{"email":"valid@example.com","age":30}`
  - Invalid payload example:
    - `{"email":"not-an-email","age":12}`

## 4. Logging Design

Custom channel in `config/logging.php`:

- Channel name: `aiops`
- Driver: `monolog`
- Handler: `StreamHandler`
- Formatter: `JsonFormatter`
- Output file: `storage/logs/aiops.log`

### Log schema (context fields)

Each telemetry log includes:

- `timestamp`
- `request_id`
- `client_ip`
- `user_agent`
- `method`
- `path`
- `query`
- `payload_size_bytes`
- `response_size_bytes`
- `route_name`
- `status_code`
- `latency_ms`
- `severity`
- `error_category`
- `build_version`
- `host`

## 5. Metrics Design

Exposed at `GET /metrics` (Prometheus text format).

### Counters

- `http_requests_total{method,path,status}`
- `http_errors_total{method,path,error_category}`

### Histogram

- `http_request_duration_seconds_bucket{method,path,le}`
- `http_request_duration_seconds_sum{method,path}`
- `http_request_duration_seconds_count{method,path}`

Buckets:

- `0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf`

### Anomaly marker metric

- `aiops_anomaly_window` gauge (`1` active, `0` inactive)
- Activated for 5 minutes when `DATABASE_ERROR`, `SYSTEM_ERROR`, or `TIMEOUT_ERROR` appears

### Cardinality controls

- Uses stable labels (`method`, normalized `path`, `status`, `error_category`)
- No request IDs in labels
- No raw query string in labels

## 6. Grafana Dashboard

Import:

- `monitoring/grafana/dashboards/aiops-red-dashboard.json`

Panels included:

1. Request rate per endpoint (RPS)
2. Error rate % per endpoint
3. P50 / P95 / P99 latency per endpoint
4. Stacked error-category breakdown
5. Anomaly window marker (`aiops_anomaly_window`)

Annotation included:

- Prometheus query: `aiops_anomaly_window == 1`

## 7. Traffic Generator (Controlled Experiment)

Script:

- `traffic_generator.py`

Base load (8-12 min):

- Total base requests target: `>= 3000` (default 3000)
- Distribution:
  - 70% `/api/normal`
  - 15% `/api/slow`
  - 5% `/api/slow?hard=1`
  - 5% `/api/error`
  - 3% `/api/db`
  - 2% `/api/validate` (50% invalid payloads)

Anomaly window:

- Exactly 2 minutes
- One type selected via `--anomaly-type`
  - `error_spike`
  - `latency_spike`

Outputs:

- `ground_truth.json`
  - `anomaly_start_iso`
  - `anomaly_end_iso`
  - `anomaly_type`
  - `expected_behavior`
- `logs.json` (strict schema, normalized records)
- `traffic_run_summary.json` with requirement checks

## 8. Setup

## 8.1 Prerequisites

- PHP 8.2+
- Composer
- Python 3.10+
- A running DB connection for Laravel
- Docker Desktop

## 8.2 Install

From project root (`Lab1_Ahmed`):

```bash
composer install
cp .env.example .env
php artisan key:generate
php artisan migrate
```

## 8.3 Run app

```bash
php artisan serve
```

Default URL: `http://127.0.0.1:8000`

## 8.4 Run monitoring stack

```bash
docker compose up -d
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000` (default `admin` / `admin`)

## 9. How To Use + Test End-to-End

## 9.1 Quick endpoint test

```bash
curl http://127.0.0.1:8000/api/normal
curl http://127.0.0.1:8000/api/error
curl "http://127.0.0.1:8000/api/slow?hard=1"
curl http://127.0.0.1:8000/metrics
```

## 9.2 Run controlled experiment

In a second terminal:

```bash
python traffic_generator.py \
  --base-url http://127.0.0.1:8000 \
  --base-minutes 8 \
  --anomaly-type latency_spike \
  --max-workers 24 \
  --reset-aiops-log \
  --output-dir .
```

For error anomaly instead:

```bash
python traffic_generator.py --base-url http://127.0.0.1:8000 --base-minutes 8 --anomaly-type error_spike --max-workers 24 --reset-aiops-log --output-dir .
```

## 9.3 Validate outputs

Check generated files:

```bash
ls ground_truth.json logs.json traffic_run_summary.json
```

Open `traffic_run_summary.json` and confirm:

- `logs_entries_ge_1500` is `true`
- `error_logs_ge_100` is `true`
- `base_requests_ge_minimum` is `true`

## 9.4 Validate `/metrics`

Ensure these appear in `/metrics` output:

- `http_requests_total`
- `http_errors_total`
- `http_request_duration_seconds_bucket`
- `http_request_duration_seconds_sum`
- `http_request_duration_seconds_count`
- `aiops_anomaly_window`

## 9.5 Validate Grafana

1. Import dashboard JSON
2. Set Prometheus datasource
3. Set time range to include experiment duration
4. Confirm:
   - RPS panel changes by endpoint
   - Error% spikes for `error_spike` runs
   - P95/P99 spikes for `latency_spike` runs
   - Stacked error category panel shows category mix
   - Anomaly marker panel/annotation shows anomaly window

## 10. Prometheus Scrape Example

The repository already includes:

- `monitoring/prometheus/prometheus.yml`

Default target:

- `host.docker.internal:8000` (Laravel app on host machine)

If needed, customize to your environment:

```yaml
scrape_configs:
  - job_name: aiops-laravel
    metrics_path: /metrics
    static_configs:
      - targets: ['host.docker.internal:8000']
```

Use target host/IP that can reach your Laravel app from Prometheus.

## 11. Troubleshooting

- `php` not found: add PHP to PATH
- `python` not found: install Python 3 and add to PATH
- Empty `aiops.log`: ensure requests are not only to `/metrics`
- No Grafana data: verify Prometheus target is `UP`
- Too few logs/errors: rerun with `--reset-aiops-log`, keep app running, and inspect `traffic_run_summary.json`

## 12. Notes On Deliverables

This repo currently includes core implementation artifacts:

- logging channel
- metrics endpoint
- dashboard JSON
- traffic generator + ground truth + log export flow
- incident detection command and JSON incident store
- automation engine command and JSON response store

External artifacts are produced by running the experiment and your monitoring stack:

- `storage/logs/aiops.log`
- generated `logs.json`
- generated `ground_truth.json`
- generated `storage/aiops/incidents.json`
- generated `storage/aiops/responses.json`
- Grafana screenshots
- report PDF

## 13. AIOps Automation Engine

The final AIOps stage in this project is an automation engine that reacts to incidents emitted by the detector.

### Command

Run one automation cycle:

```bash
php artisan aiops:respond
```

Run continuously:

```bash
php artisan aiops:respond --watch --interval=20
```

Simulate a failed action to demonstrate escalation:

```bash
php artisan aiops:respond --simulate-failure=ERROR_STORM
```

### Response policies

Configured in `config/aiops.php`:

- `LATENCY_SPIKE` -> `restart_service`
- `ERROR_STORM` -> `send_alert`
- `TRAFFIC_SURGE` -> `scale_service`
- `SERVICE_DEGRADATION` -> `restart_service`
- `LOCALIZED_ENDPOINT_FAILURE` -> `traffic_throttling`

### Action simulation and logs

Actions are simulated for lab safety, but every response is written to `storage/aiops/responses.json` with:

- `incident_id`
- `action_taken`
- `timestamp`
- `result`
- `notes`

The engine also tracks prior responses in `storage/aiops/response_state.json` so it can identify incidents that remain open.

### Escalation logic

The engine raises `CRITICAL_ALERT` when either:

1. the simulated automated action fails
2. the incident is still open during a later response cycle after an earlier automated response

### Demonstration flow

1. Run `php artisan aiops:detect`
2. Trigger latency or error anomalies
3. Confirm incidents appear in `storage/aiops/incidents.json`
4. Run `php artisan aiops:respond`
5. Inspect `storage/aiops/responses.json`
6. Run `php artisan aiops:respond` again while an incident is still open to demonstrate escalation
