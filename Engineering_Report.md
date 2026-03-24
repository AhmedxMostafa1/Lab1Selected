# Engineering Report - AIOps Detection Engine

## 1. Objective

The goal of this lab is to move from passive observability to active detection.

In Lab Work 1, the Laravel API already emitted structured logs, correlation IDs, error categories, latency measurements, and Prometheus RED metrics. In Lab Work 2, I extended that platform with an AIOps Detection Engine that continuously queries Prometheus, learns per-endpoint baselines from real observations, detects anomalous behavior using multiple signals, correlates related abnormal signals into higher-level incidents, and emits deduplicated alerts.

The final system acts as an always-running detector rather than a dashboard-only monitoring solution.

## 2. System Overview

The implemented detection pipeline has four major parts:

1. Laravel telemetry and Prometheus metrics from Lab 1
2. A Prometheus API client inside Laravel
3. A continuous anomaly-detection command
4. Incident generation and alerting

The end-to-end flow is:

1. Application requests generate logs and Prometheus metrics.
2. Prometheus scrapes the Laravel `/metrics` endpoint.
3. The `php artisan aiops:detect` command queries Prometheus every 20 seconds.
4. The detector computes rolling baselines for each monitored endpoint.
5. The detector applies anomaly rules across latency, errors, and traffic.
6. The detector correlates abnormal signals into incidents.
7. New incidents are written to `storage/aiops/incidents.json`.
8. A JSON console alert is emitted once per incident fingerprint.

## 3. Monitored Endpoints

Baselines and anomaly analysis are computed for the required endpoints:

- `/api/normal`
- `/api/slow`
- `/api/db`
- `/api/error`
- `/api/validate`

These endpoints represent a useful mix of healthy traffic, slow responses, validation failures, server errors, and database-related failures.

## 4. Detection Engine Command

The continuous detection engine is implemented as the Laravel command:

```bash
php artisan aiops:detect
```

Behavior:

- runs continuously
- does not terminate automatically
- executes every 20 seconds by default
- clamps the interval to the required 20-30 second range
- queries Prometheus metrics each cycle
- evaluates system health
- detects anomalies
- generates incidents
- prints current metric values in the console

Implementation notes:

- The command is implemented in `app/Console/Commands/AIOpsDetectCommand.php`.
- Command discovery is enabled in `bootstrap/app.php`.
- The console output includes a live table with:
  - endpoint
  - request rate
  - error rate
  - average latency
  - p95 latency
  - active anomaly signals

This satisfies the requirement that the detector must visibly show current metrics in console logs.

## 5. Prometheus Metrics Integration

### 5.1 Prometheus Client

The required Laravel service was implemented as:

- `App\Services\PrometheusClient`

It queries the Prometheus HTTP API at:

- `http://localhost:9090/api/v1/query`

### 5.2 Queried Signals

The client retrieves the required signals using PromQL:

- request rate per endpoint
- error rate per endpoint
- average latency per endpoint
- latency percentiles per endpoint
- error category counters per endpoint

The implementation uses these metric families from Lab 1:

- `http_requests_total`
- `http_errors_total`
- `http_request_duration_seconds_bucket`
- `http_request_duration_seconds_sum`
- `http_request_duration_seconds_count`

### 5.3 PromQL Strategy

The Prometheus client calculates:

- request rate from `rate(http_requests_total[2m])`
- error rate from `rate(http_errors_total[2m]) / rate(http_requests_total[2m])`
- average latency from histogram `sum / count` rate expressions
- p50, p95, and p99 using `histogram_quantile`
- error category counters using `increase(http_errors_total[5m])`

This design is appropriate because the detector should work from live operational data instead of directly parsing application logs.

## 6. Baseline Modeling

### 6.1 Why Baselines Are Needed

A fixed threshold-only detector would be too brittle. Some endpoints are naturally slow, some are naturally noisy, and traffic volume varies by route. Because of that, the detector builds endpoint-specific baselines from real observed behavior.

### 6.2 Baseline Storage

The detector stores rolling internal state in:

- `storage/aiops/detector_state.json`

The file contains:

- historical healthy samples per endpoint
- currently active incident fingerprints

### 6.3 Baseline Signals

For each monitored endpoint, the detector learns:

- average latency baseline
- request-rate baseline
- error-rate baseline

### 6.4 Baseline Method

The implemented baseline is a rolling trimmed average over recent healthy observations:

- each healthy cycle contributes one history record
- anomalous cycles are excluded from baseline growth
- history is capped to a fixed rolling window
- when enough history exists, the detector computes a trimmed mean
- the smallest and largest samples are discarded when the sample count is large enough

This approach keeps the baseline stable while limiting the influence of outliers and short anomaly bursts.

### 6.5 Why This Meets the Requirement

The rubric explicitly requires that baseline values are not hardcoded. In this implementation:

- no baseline is manually configured
- all baseline values come from observed Prometheus metrics
- baselines are calculated independently per endpoint

That directly satisfies the baseline modeling requirement.

## 7. Multi-Signal Anomaly Detection

The detector evaluates multiple classes of abnormal behavior instead of relying on a single metric.

### 7.1 Latency Anomaly

A latency signal is created when:

- average latency is greater than `3 x baseline`
- or p95 latency exceeds a stronger latency envelope

This is designed to catch both broad slowdown and tail-latency inflation.

### 7.2 Error-Rate Anomaly

An error-rate signal is created when:

- error rate is above `10%`
- and also significantly above the learned baseline

This prevents trivial noise from becoming incidents while still detecting real endpoint failure.

### 7.3 Traffic Anomaly

A traffic anomaly is created when:

- request rate is greater than `2 x baseline`

This captures sudden traffic surges or bursty behavior that can later correlate with performance degradation.

### 7.4 Endpoint-Specific Anomaly

A localized endpoint anomaly is created when:

- one endpoint's error rate is much worse than peer endpoints

The implementation compares the endpoint error rate to the median of the other monitored endpoints. This helps separate a localized route failure from broad service-wide problems.

### 7.5 Why Multi-Signal Detection Matters

Using multiple signals improves accuracy:

- latency alone can indicate slowness but not necessarily failure
- error rate alone can miss slow-but-successful unhealthy requests
- traffic alone can represent load, not breakage
- correlation between signals gives more operational meaning

This directly supports the lab goal of automated incident discovery rather than simple threshold alerting.

## 8. Event Correlation Strategy

The detector does not emit one alert per raw metric breach. Instead, it groups related abnormal signals into higher-level incident types.

### 8.1 Correlated Incident Types

The implemented incident types are:

- `SERVICE_DEGRADATION`
- `ERROR_STORM`
- `LATENCY_SPIKE`
- `LOCALIZED_ENDPOINT_FAILURE`
- `TRAFFIC_SURGE`

### 8.2 Correlation Logic

The implemented strategy is:

- if multiple endpoints show strong error behavior together, generate `ERROR_STORM`
- if multiple endpoints show latency anomalies together, generate `SERVICE_DEGRADATION`
- if multiple endpoints show traffic surge together, generate `TRAFFIC_SURGE`
- if one endpoint fails independently, generate `LOCALIZED_ENDPOINT_FAILURE`
- if one endpoint becomes slow independently, generate `LATENCY_SPIKE`

This is important because operations teams need one meaningful incident, not many noisy alerts from the same underlying problem.

### 8.3 Deduplication

Each incident is fingerprinted using:

- `incident_type`
- `affected_endpoints`

If the same fingerprint is still active in later cycles:

- the incident remains active
- the detector updates internal active state
- no repeated alert is emitted

This satisfies the hard requirement that repeated alerts for the same incident must be suppressed.

## 9. Incident Schema

When the detector confirms an abnormal condition, it creates a structured incident object and appends it to:

- `storage/aiops/incidents.json`

Each incident includes the required stable fields:

- `incident_id`
- `incident_type`
- `severity`
- `status`
- `detected_at`
- `affected_service`
- `affected_endpoints`
- `triggering_signals`
- `baseline_values`
- `observed_values`
- `summary`

Additionally, when the system recovers, the incident is marked resolved and a `resolved_at` field is added.

This schema supports:

- machine parsing
- timeline reconstruction
- analyst triage
- future dashboard or webhook integration

## 10. Alerting Design

### 10.1 Alert Format

The detector currently emits JSON console alerts when a new incident is created.

Each alert includes:

- `incident_id`
- `incident_type`
- `severity`
- `timestamp`
- `summary`

This matches the required alert payload format.

### 10.2 Webhook Support

The implementation also supports optional webhook delivery through configuration:

- `AIOPS_WEBHOOK_URL`

If configured, the detector sends the same alert payload through an HTTP POST request.

### 10.3 Deduplication Behavior

Alert deduplication is implemented using active incident fingerprints.

Behavior:

- first occurrence of an incident emits one alert
- repeated cycles for the same active incident do not emit more alerts
- once the anomaly clears, the incident is resolved
- if the same failure happens again later, it can generate a new incident

This behavior reduces alert fatigue and improves signal quality.

## 11. How the Detector Identifies the Lab 1 Anomaly Window

The anomaly window from Lab 1 was intentionally designed to produce abnormal combinations of:

- severe latency
- server errors
- database failures
- validation errors
- bursty traffic shifts

This detector is capable of identifying that window because:

- `/api/slow?hard=1` creates strong latency inflation
- `/api/error` creates an elevated error-rate pattern
- `/api/db?fail=1` contributes database-related error spikes
- rapid traffic variation increases request-rate deviation from baseline
- simultaneous abnormal behavior across several endpoints triggers correlated incidents

In practice, the detector should surface that window as one or more of:

- `SERVICE_DEGRADATION`
- `ERROR_STORM`
- `LATENCY_SPIKE`
- `LOCALIZED_ENDPOINT_FAILURE`

depending on which endpoints are under stress at the same time.

## 12. Files Added or Updated

Key implementation files:

- `app/Services/PrometheusClient.php`
- `app/Services/AIOpsDetectionEngine.php`
- `app/Console/Commands/AIOpsDetectCommand.php`
- `app/Providers/AppServiceProvider.php`
- `bootstrap/app.php`
- `config/services.php`
- `tests/Unit/PrometheusClientTest.php`
- `tests/Unit/AIOpsDetectionEngineTest.php`

Data output files:

- `storage/aiops/detector_state.json`
- `storage/aiops/incidents.json`

## 13. Testing Procedure

To validate the system, the following test process should be used:

1. Start the Laravel application.
2. Start Prometheus and confirm it is scraping `/metrics`.
3. Generate normal traffic first to allow the detector to learn baselines.
4. Start `php artisan aiops:detect`.
5. Confirm that the console prints live endpoint metrics every 20 seconds.
6. Trigger slow, error, database-failure, validation-failure, and traffic-surge conditions.
7. Confirm that incidents are written to `storage/aiops/incidents.json`.
8. Confirm that alerts appear only once per active incident.
9. Stop abnormal traffic and confirm incidents become resolved.

## 14. Evidence and Screenshots

Insert screenshots in this section before submission.

### 14.1 Detector Console

Screenshot placeholder:

- paste screenshot of `php artisan aiops:detect` showing the metrics table

### 14.2 Incident File

Screenshot placeholder:

- paste screenshot of `storage/aiops/incidents.json`

### 14.3 Alert Example

Screenshot placeholder:

- paste screenshot of the JSON alert emitted in the terminal

### 14.4 Prometheus or Grafana Validation

Screenshot placeholder:

- paste screenshot showing the underlying metrics or anomaly window

## 15. Sample Incident Template

The following example shows the expected structure of an incident generated by the detector:

```json
{
  "incident_id": "generated-uuid",
  "incident_type": "LOCALIZED_ENDPOINT_FAILURE",
  "severity": "critical",
  "status": "open",
  "detected_at": "2026-03-24T10:10:00+02:00",
  "affected_service": "Laravel",
  "affected_endpoints": [
    "/api/error"
  ],
  "triggering_signals": [
    {
      "signal_type": "error_rate",
      "endpoint": "/api/error",
      "metric": "error_rate",
      "observed": 0.95,
      "baseline": 0.01,
      "reason": "Error rate crossed the endpoint threshold."
    }
  ],
  "baseline_values": {
    "/api/error": {
      "average_latency": 0.05,
      "request_rate": 1.20,
      "error_rate": 0.01,
      "sample_size": 5
    }
  },
  "observed_values": {
    "/api/error": {
      "request_rate": 1.80,
      "error_rate": 0.95,
      "errors_per_second": 1.71,
      "average_latency": 0.06,
      "latency_percentiles": {
        "p50": 0.03,
        "p95": 0.09,
        "p99": 0.11
      },
      "error_category_counters": {
        "SYSTEM_ERROR": 9
      }
    }
  },
  "summary": "Endpoint /api/error is failing independently of the rest of the service."
}
```

## 16. Sample Alert Template

The following example shows the alert payload emitted when a new incident is created:

```json
{
  "alert": {
    "incident_id": "generated-uuid",
    "incident_type": "LOCALIZED_ENDPOINT_FAILURE",
    "severity": "critical",
    "timestamp": "2026-03-24T10:10:00+02:00",
    "summary": "Endpoint /api/error is failing independently of the rest of the service."
  }
}
```

## 17. Rubric Mapping

### 17.1 Detection Engine (40)

- Prometheus metrics integration: implemented through `PrometheusClient`
- baseline modeling: implemented through rolling per-endpoint healthy history
- anomaly rules: implemented for latency, error rate, traffic, and endpoint-specific failure

### 17.2 Event Correlation (25)

- correct incident correlation: implemented through grouped signal correlation
- incident schema quality: implemented with stable structured JSON incidents

### 17.3 Alerting (15)

- alert correctness: implemented with required incident fields
- alert deduplication: implemented through active incident fingerprint suppression

### 17.4 System Behavior (10)

- the detector is designed to identify the Lab 1 anomaly window using live Prometheus data and correlated anomalies

### 17.5 Report (10)

- this report explains baseline design, anomaly rules, correlation strategy, testing, evidence, and deliverables

## 18. Conclusion

This lab successfully extends the Laravel observability platform from metric exposure into automated incident detection.

The completed system:

- continuously monitors Prometheus metrics
- learns endpoint-specific baselines from real behavior
- detects anomalies using multiple signals
- correlates low-level symptoms into higher-level incidents
- emits structured incidents and deduplicated alerts

As a result, the system now supports active operational detection rather than relying only on dashboards and manual inspection.
