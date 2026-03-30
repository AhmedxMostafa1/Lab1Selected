# ML Engineering Report

## Objective

This lab replaces the Lab Work 2 rule-based detector with an unsupervised Machine Learning detector that learns normal telemetry behavior and flags anomalous 30-second windows automatically.

## Dataset Construction

- Source log file: `logs.json`
- Reconstructed Prometheus-style metrics history: `prometheus_metrics_history.csv`
- Observation count: 2845
- Training observations from normal period only: 2255
- Monitoring endpoints: /api/db, /api/error, /api/normal, /api/slow, /api/validate
- Window size: 30 seconds
- Reconstructed scrape interval: 1 second

The dataset was built by replaying `logs.json` into cumulative Prometheus-style request, error, and latency totals for each endpoint. A 30-second trailing window was then sampled every second, which produced a dense telemetry dataset that satisfies the minimum observation requirement while preserving the RED metric behavior from Lab Work 1.

## Chosen Features

The model uses the following engineered operational features for every endpoint snapshot:

- `avg_latency`
- `max_latency`
- `request_rate`
- `error_rate`
- `latency_std`
- `errors_per_window`
- `endpoint_frequency`
- current `latency`
- `request_count_window`
- error-category composition shares for timeout, system, validation, and database failures
- one-hot encoded endpoint identity
- one-hot encoded dominant error category

These features were selected because they cover both performance degradation and failure-mode changes. The required latency and traffic features capture the shape of normal behavior, while the endpoint and error-category encodings keep the detector from incorrectly treating inherently noisy routes such as `/api/error` as abnormal during the normal period.

## Model Selection

- Model: Isolation Forest
- Trees: 120
- Sample size per tree: 256

Isolation Forest was chosen because the task is unsupervised anomaly detection and the rubric allows it explicitly. It also works well with mixed telemetry features and does not require labeled anomalies during training. The model was trained only on observations with timestamps before the anomaly start time of 2026-03-07T14:32:56.133Z.

## Detection Performance

- Ground-truth anomaly type: `latency_spike`
- Ground-truth anomaly interval: 2026-03-07T14:32:56.133Z to 2026-03-07T14:34:56.133Z
- Predicted anomaly windows: 3
- Ground-truth anomaly windows: 3
- True positive windows: 2
- False positive windows: 1
- False negative windows: 1
- Precision: 0.6667
- Recall: 0.6667
- Detected overlap with ground truth: Yes
- Peak slow-endpoint latency window: 2026-03-07T14:34:26.000Z (6259.083 ms)

The detector scores every endpoint snapshot and then aggregates those scores into 30-second window predictions. A window threshold is derived only from the normal-period score distribution, so the anomaly decision is still learned from healthy behavior instead of being hardcoded against the anomaly interval.

## Deliverables Produced

- Dataset: `aiops_dataset.csv`
- Predictions: `anomaly_predictions.csv`
- Prometheus history replay: `prometheus_metrics_history.csv`
- Latency plot: `visualizations\ml\latency_timeline.svg`
- Error-rate plot: `visualizations\ml\error_rate_timeline.svg`
- Anomaly-score plot: `visualizations\ml\anomaly_score_timeline.svg`
- Combined overview plot: `visualizations\ml\overview.svg`
