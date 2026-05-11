# Root Cause Analysis Report

## Executive Summary

Incident INC-20260307T143356Z was selected from the detected anomaly windows in `anomaly_predictions.csv`. The most likely root cause endpoint is `/api/slow`, and the primary degraded signal is `latency`. The RCA confidence score is 0.881665.

The strongest evidence is that `/api/slow` moved from a baseline average latency of 1054.65 ms to 2114 ms during the anomaly window, with a peak max latency of 7016.15 ms. Its error rate also increased to 0.214, driven mainly by `TIMEOUT_ERROR`.

## Incident Selection

- Selected incident ID: `INC-20260307T143356Z`
- Window start: 2026-03-07T14:33:26.000Z
- Window end: 2026-03-07T14:34:26.000Z
- Peak anomaly timestamp: 2026-03-07T14:34:26.000Z
- Anomaly score: 0.711695
- Learned threshold: 0.699493

The selected window is the highest-scoring detected anomaly that overlaps the ground-truth anomaly period in the Lab 3 predictions.

## Signal Analysis

The RCA script compares the selected incident window against all earlier normal windows. It evaluates latency, request rate, error rate, endpoint activity, and error-category composition for every endpoint.

| Endpoint | Contribution | Avg Latency Delta | Error Rate Delta | Request Rate Delta | Activity Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/api/slow` | 8.155806 | 1059.36 ms | 0.022 | 0.19 req/s | 0.117 |
| `/api/error` | 0.493712 | 1.64 ms | 0 | 0.099 req/s | 0.035 |
| `/api/normal` | 0.313623 | 1.09 ms | 0 | 0.438 req/s | 0.196 |
| `/api/db` | 0.153325 | 6.93 ms | 0 | 0 req/s | 0.011 |
| `/api/validate` | 0.102492 | 2.75 ms | -0.093 | 0.021 req/s | 0.008 |

## Endpoint Attribution

`/api/slow` contributed most to the anomaly. The endpoint had the largest combined lift in average latency, maximum latency, anomaly score, and timeout-heavy error composition. This matches the expected Lab behavior where `/api/slow?hard=1` creates a latency spike.

## Error Category Analysis

| Error Category | Estimated Count | Share |
| --- | ---: | ---: |
| `TIMEOUT_ERROR` | 219.000026 | 0.390374 |
| `SYSTEM_ERROR` | 300 | 0.534759 |
| `DATABASE_ERROR` | 0 | 0 |
| `VALIDATION_ERROR` | 41.999988 | 0.074866 |
| `UNKNOWN` | 0 | 0 |

The overall anomaly window contains background failures from other synthetic lab endpoints, so the RCA also isolates the root-cause endpoint. For `/api/slow`, the dominant category is `TIMEOUT_ERROR`, which supports a timeout-driven latency incident instead of a broad system or database failure.

## Incident Timeline

- **normal_state** (2026-03-07T14:33:26.000Z): Window below anomaly threshold with score 0.614619.
- **anomaly_start** (2026-03-07T14:33:26.000Z): Detected anomaly group opened for /api/slow.
- **peak_incident** (2026-03-07T14:34:25.000Z): /api/slow reached avg latency 6259.08 ms with 0.214 error rate.
- **recovery** (2026-03-07T14:34:26.000Z): Recovery was not captured in the exported prediction range; dataset ends while the incident is still active or tapering.

The timeline visualization is available at `visualizations\rca\incident_timeline.svg`.

## Root Cause Output

- `incident_id`: `INC-20260307T143356Z`
- `root_cause_endpoint`: `/api/slow`
- `primary_signal`: `latency`
- `confidence_score`: 0.881665
- `recommended_action`: Investigate /api/slow slow path, reduce timeout-prone work, and add a latency guard or async queue for hard slow requests.

## Recommendation

Prioritize `/api/slow` remediation. Add request-level timeout protection around the slow execution branch, monitor the TIMEOUT_ERROR share as a leading indicator, and keep the endpoint-specific latency alert separate from global error-rate alerts so future slow-path incidents are attributed faster.
