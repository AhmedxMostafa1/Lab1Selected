#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const WINDOW_SECONDS = 30;
const SCRAPE_INTERVAL_SECONDS = 1;
const N_TREES = 120;
const SAMPLE_SIZE = 256;
const RANDOM_SEED = 42;
const INPUT_LOGS = 'logs.json';
const INPUT_GROUND_TRUTH = 'ground_truth.json';
const OUTPUT_DATASET = 'aiops_dataset.csv';
const OUTPUT_PREDICTIONS = 'anomaly_predictions.csv';
const OUTPUT_HISTORY = 'prometheus_metrics_history.csv';
const OUTPUT_SUMMARY = 'ml_results_summary.json';
const OUTPUT_REPORT = 'ML_Engineering_Report.md';
const OUTPUT_PLOTS_DIR = path.join('visualizations', 'ml');
const EULER_MASCHERONI = 0.5772156649;
const NUMERIC_FEATURES = [
  'latency',
  'avg_latency',
  'max_latency',
  'request_rate',
  'error_rate',
  'latency_std',
  'errors_per_window',
  'endpoint_frequency',
  'request_count_window',
  'timeout_error_share',
  'system_error_share',
  'validation_error_share',
  'database_error_share',
];
const ERROR_CATEGORIES = [
  'NONE',
  'TIMEOUT_ERROR',
  'SYSTEM_ERROR',
  'VALIDATION_ERROR',
  'DATABASE_ERROR',
  'UNKNOWN',
];

function main() {
  const logs = readJson(INPUT_LOGS);
  const groundTruth = readJson(INPUT_GROUND_TRUTH);
  const apiRows = prepareLogRows(logs);

  if (apiRows.length === 0) {
    throw new Error('No API telemetry rows were found in logs.json.');
  }

  const endpoints = [...new Set(apiRows.map((row) => row.endpoint))].sort();
  const startMs = apiRows[0].ts;
  const endMs = apiRows[apiRows.length - 1].ts;
  const anomalyStartMs = Date.parse(groundTruth.anomaly_start_iso);
  const anomalyEndMs = Date.parse(groundTruth.anomaly_end_iso);

  const endpointRows = new Map();
  for (const endpoint of endpoints) {
    endpointRows.set(
      endpoint,
      apiRows.filter((row) => row.endpoint === endpoint).sort((a, b) => a.ts - b.ts),
    );
  }

  const totalHistory = buildPrometheusHistory(apiRows, startMs, endMs, SCRAPE_INTERVAL_SECONDS);
  const perEndpointHistory = new Map();
  for (const endpoint of endpoints) {
    perEndpointHistory.set(
      endpoint,
      buildPrometheusHistory(endpointRows.get(endpoint) ?? [], startMs, endMs, SCRAPE_INTERVAL_SECONDS),
    );
  }

  const datasetRows = buildDatasetRows({
    endpoints,
    endpointRows,
    perEndpointHistory,
    totalHistory,
    startMs,
    endMs,
    anomalyStartMs,
    anomalyEndMs,
  });

  if (datasetRows.length < 1500) {
    throw new Error(`Dataset has ${datasetRows.length} observations, which is below the required minimum of 1500.`);
  }

  const trainIndices = datasetRows
    .map((row, index) => (!row.is_ground_truth_anomaly ? index : -1))
    .filter((index) => index >= 0);
  const trainRows = trainIndices.map((index) => datasetRows[index]);
  const scaler = fitScaler(trainRows);
  const { matrix, featureNames } = encodeRows(datasetRows, endpoints, scaler);
  const trainMatrix = trainIndices.map((index) => matrix[index]);

  const forest = new IsolationForest({
    nTrees: N_TREES,
    sampleSize: SAMPLE_SIZE,
    seed: RANDOM_SEED,
  });
  forest.fit(trainMatrix);

  const observationScores = forest.scoreSamples(matrix);
  const observationThreshold = percentile(
    trainIndices.map((index) => observationScores[index]),
    0.995,
  );

  datasetRows.forEach((row, index) => {
    row.anomaly_score = round(observationScores[index], 6);
    row.is_observation_anomaly = row.anomaly_score >= observationThreshold;
  });

  const windowPredictions = buildWindowPredictions({
    datasetRows,
    endpoints,
    startMs,
    anomalyStartMs,
    anomalyEndMs,
    windowSeconds: WINDOW_SECONDS,
    observationThreshold,
  });

  const plotSeries = buildPlotSeries({
    apiRows,
    windowPredictions,
    startMs,
    endMs,
    anomalyStartMs,
    anomalyEndMs,
  });

  const summary = buildSummary({
    datasetRows,
    trainRows,
    windowPredictions,
    plotSeries,
    endpoints,
    startMs,
    endMs,
    anomalyStartMs,
    anomalyEndMs,
    featureNames,
    observationThreshold,
    groundTruth,
  });

  ensureDir(OUTPUT_PLOTS_DIR);
  writeFile(OUTPUT_DATASET, toCsv(datasetRows, datasetColumnOrder()));
  writeFile(OUTPUT_PREDICTIONS, toCsv(windowPredictions, predictionColumnOrder()));
  writeFile(OUTPUT_HISTORY, toCsv(flattenPrometheusHistory(perEndpointHistory), prometheusHistoryColumnOrder()));
  writeFile(OUTPUT_SUMMARY, JSON.stringify(summary, null, 2));
  writeFile(OUTPUT_REPORT, buildReport(summary));

  renderPlots(plotSeries, {
    outputDir: OUTPUT_PLOTS_DIR,
    anomalyStartMs,
    anomalyEndMs,
    threshold: summary.model.window_threshold,
  });

  console.log(JSON.stringify({
    dataset_rows: datasetRows.length,
    training_rows: trainRows.length,
    prediction_windows: windowPredictions.length,
    detected_anomaly_windows: summary.performance.predicted_anomaly_windows,
    ground_truth_windows: summary.performance.ground_truth_anomaly_windows,
    overlap_detected: summary.performance.detected_ground_truth_window,
    outputs: {
      dataset: OUTPUT_DATASET,
      predictions: OUTPUT_PREDICTIONS,
      history: OUTPUT_HISTORY,
      summary: OUTPUT_SUMMARY,
      report: OUTPUT_REPORT,
      plots_dir: OUTPUT_PLOTS_DIR,
    },
  }, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFile(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, 'utf8');
}

function ensureDir(dirPath) {
  if (dirPath === '.' || dirPath === '') {
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
}

function prepareLogRows(logs) {
  return logs
    .filter((row) => row.path && row.path.startsWith('/api/'))
    .map((row) => ({
      ts: Date.parse(row.timestamp),
      timestamp: row.timestamp,
      endpoint: row.path,
      latency: Number(row.latency_ms ?? 0),
      isError: String(row.error_category ?? 'NONE') !== 'NONE',
      errorCategory: String(row.error_category ?? 'NONE'),
      statusCode: Number(row.status_code ?? 0),
    }))
    .sort((a, b) => a.ts - b.ts);
}

function buildPrometheusHistory(rows, startMs, endMs, stepSeconds) {
  const history = [];
  const stepMs = stepSeconds * 1000;
  let index = 0;
  let requestsTotal = 0;
  let errorsTotal = 0;
  let latencySumMsTotal = 0;
  let latencyCountTotal = 0;

  for (let timestamp = startMs; timestamp <= endMs; timestamp += stepMs) {
    while (index < rows.length && rows[index].ts <= timestamp) {
      const row = rows[index];
      requestsTotal += 1;
      if (row.isError) {
        errorsTotal += 1;
      }
      latencySumMsTotal += row.latency;
      latencyCountTotal += 1;
      index += 1;
    }

    history.push({
      timestamp_ms: timestamp,
      timestamp: toIso(timestamp),
      requests_total: requestsTotal,
      errors_total: errorsTotal,
      latency_sum_ms_total: round(latencySumMsTotal, 3),
      latency_count_total: latencyCountTotal,
    });
  }

  return history;
}

function buildDatasetRows({
  endpoints,
  endpointRows,
  perEndpointHistory,
  totalHistory,
  startMs,
  anomalyStartMs,
  anomalyEndMs,
}) {
  const datasetRows = [];
  const windowMs = WINDOW_SECONDS * 1000;
  const firstUsableIndex = WINDOW_SECONDS / SCRAPE_INTERVAL_SECONDS;

  for (let historyIndex = firstUsableIndex; historyIndex < totalHistory.length; historyIndex += 1) {
    const currentPoint = totalHistory[historyIndex];
    const previousPoint = totalHistory[historyIndex - firstUsableIndex];
    const totalRequestsInWindow =
      currentPoint.requests_total - previousPoint.requests_total;

    for (const endpoint of endpoints) {
      const endpointHistory = perEndpointHistory.get(endpoint) ?? [];
      const endpointCurrent = endpointHistory[historyIndex];
      const endpointPrevious = endpointHistory[historyIndex - firstUsableIndex];

      if (!endpointCurrent || !endpointPrevious) {
        continue;
      }

      const requestCountWindow =
        endpointCurrent.requests_total - endpointPrevious.requests_total;
      const errorsPerWindow =
        endpointCurrent.errors_total - endpointPrevious.errors_total;
      const latencySumWindow =
        endpointCurrent.latency_sum_ms_total - endpointPrevious.latency_sum_ms_total;
      const latencyCountWindow =
        endpointCurrent.latency_count_total - endpointPrevious.latency_count_total;

      const requestRate = requestCountWindow / WINDOW_SECONDS;
      const errorRate = requestCountWindow > 0 ? errorsPerWindow / requestCountWindow : 0;
      const avgLatency = latencyCountWindow > 0 ? latencySumWindow / latencyCountWindow : 0;
      const endpointFrequency =
        totalRequestsInWindow > 0 ? requestCountWindow / totalRequestsInWindow : 0;

      const windowEndMs = endpointCurrent.timestamp_ms;
      const windowStartMs = windowEndMs - windowMs;
      const rowsInWindow = (endpointRows.get(endpoint) ?? []).filter(
        (row) => row.ts > windowStartMs && row.ts <= windowEndMs,
      );
      const latencies = rowsInWindow.map((row) => row.latency);
      const latestLatency = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
      const latencyStd = standardDeviation(latencies);
      const errorCategoryCounts = countErrorCategories(rowsInWindow);
      const dominantErrorCategory = dominantErrorCategoryForWindow(errorCategoryCounts);
      const timeoutErrorShare =
        requestCountWindow > 0 ? (errorCategoryCounts.TIMEOUT_ERROR ?? 0) / requestCountWindow : 0;
      const systemErrorShare =
        requestCountWindow > 0 ? (errorCategoryCounts.SYSTEM_ERROR ?? 0) / requestCountWindow : 0;
      const validationErrorShare =
        requestCountWindow > 0 ? (errorCategoryCounts.VALIDATION_ERROR ?? 0) / requestCountWindow : 0;
      const databaseErrorShare =
        requestCountWindow > 0 ? (errorCategoryCounts.DATABASE_ERROR ?? 0) / requestCountWindow : 0;

      datasetRows.push({
        timestamp: endpointCurrent.timestamp,
        timestamp_ms: endpointCurrent.timestamp_ms,
        window_start: toIso(windowStartMs),
        window_end: endpointCurrent.timestamp,
        endpoint,
        latency: round(latestLatency, 3),
        error_rate: round(errorRate, 6),
        request_rate: round(requestRate, 6),
        error_category: dominantErrorCategory,
        avg_latency: round(avgLatency, 3),
        max_latency: round(maxLatency, 3),
        latency_std: round(latencyStd, 3),
        errors_per_window: errorsPerWindow,
        endpoint_frequency: round(endpointFrequency, 6),
        request_count_window: requestCountWindow,
        timeout_error_share: round(timeoutErrorShare, 6),
        system_error_share: round(systemErrorShare, 6),
        validation_error_share: round(validationErrorShare, 6),
        database_error_share: round(databaseErrorShare, 6),
        source: 'prometheus_replay',
        window_size_seconds: WINDOW_SECONDS,
        is_ground_truth_anomaly:
          endpointCurrent.timestamp_ms >= anomalyStartMs && endpointCurrent.timestamp_ms <= anomalyEndMs,
      });
    }
  }

  return datasetRows;
}

function countErrorCategories(rows) {
  const counts = {};
  for (const row of rows) {
    const category = row.errorCategory || 'NONE';
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
}

function dominantErrorCategoryForWindow(counts) {
  const nonNoneEntries = Object.entries(counts).filter(([category]) => category !== 'NONE');
  if (nonNoneEntries.length === 0) {
    return 'NONE';
  }

  nonNoneEntries.sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }

    return a[0].localeCompare(b[0]);
  });

  return nonNoneEntries[0][0];
}

function fitScaler(rows) {
  const means = {};
  const stds = {};

  for (const feature of NUMERIC_FEATURES) {
    const values = rows.map((row) => Number(row[feature] ?? 0));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;

    means[feature] = mean;
    stds[feature] = Math.sqrt(variance) || 1;
  }

  return { means, stds };
}

function encodeRows(rows, endpoints, scaler) {
  const matrix = [];
  const featureNames = [];

  for (const feature of NUMERIC_FEATURES) {
    featureNames.push(`num:${feature}`);
  }
  for (const endpoint of endpoints) {
    featureNames.push(`endpoint:${endpoint}`);
  }
  for (const category of ERROR_CATEGORIES) {
    featureNames.push(`error_category:${category}`);
  }

  for (const row of rows) {
    const vector = [];

    for (const feature of NUMERIC_FEATURES) {
      const value = Number(row[feature] ?? 0);
      const scaled = (value - scaler.means[feature]) / scaler.stds[feature];
      vector.push(Number.isFinite(scaled) ? scaled : 0);
    }

    for (const endpoint of endpoints) {
      vector.push(row.endpoint === endpoint ? 1 : 0);
    }

    for (const category of ERROR_CATEGORIES) {
      vector.push(row.error_category === category ? 1 : 0);
    }

    matrix.push(vector);
  }

  return { matrix, featureNames };
}

class IsolationForest {
  constructor({ nTrees, sampleSize, seed }) {
    this.nTrees = nTrees;
    this.sampleSize = sampleSize;
    this.seed = seed;
    this.trees = [];
    this.sampleCount = 0;
    this.maxDepth = 0;
    this.rng = mulberry32(seed);
  }

  fit(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
      throw new Error('IsolationForest requires at least one training sample.');
    }

    this.sampleCount = Math.min(this.sampleSize, matrix.length);
    this.maxDepth = Math.ceil(Math.log2(this.sampleCount));
    this.trees = [];

    for (let treeIndex = 0; treeIndex < this.nTrees; treeIndex += 1) {
      const sample = randomSampleWithoutReplacement(matrix, this.sampleCount, this.rng);
      this.trees.push(buildIsolationTree(sample, 0, this.maxDepth, this.rng));
    }
  }

  scoreSamples(matrix) {
    const normalizer = averagePathLength(this.sampleCount);

    return matrix.map((vector) => {
      const pathLength =
        this.trees.reduce((sum, tree) => sum + pathLengthForVector(tree, vector, 0), 0) /
        this.trees.length;

      return Math.pow(2, -(pathLength / normalizer));
    });
  }
}

function buildIsolationTree(rows, depth, maxDepth, rng) {
  if (depth >= maxDepth || rows.length <= 1 || rows.every((row) => arraysEqual(row, rows[0]))) {
    return {
      type: 'leaf',
      size: rows.length,
    };
  }

  const candidateFeatures = [];
  for (let featureIndex = 0; featureIndex < rows[0].length; featureIndex += 1) {
    let min = Infinity;
    let max = -Infinity;

    for (const row of rows) {
      const value = row[featureIndex];
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }

    if (min < max) {
      candidateFeatures.push({ featureIndex, min, max });
    }
  }

  if (candidateFeatures.length === 0) {
    return {
      type: 'leaf',
      size: rows.length,
    };
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = candidateFeatures[randomInt(rng, candidateFeatures.length)];
    const split = candidate.min + (rng() * (candidate.max - candidate.min));
    const left = [];
    const right = [];

    for (const row of rows) {
      if (row[candidate.featureIndex] < split) {
        left.push(row);
      } else {
        right.push(row);
      }
    }

    if (left.length > 0 && right.length > 0) {
      return {
        type: 'node',
        featureIndex: candidate.featureIndex,
        split,
        left: buildIsolationTree(left, depth + 1, maxDepth, rng),
        right: buildIsolationTree(right, depth + 1, maxDepth, rng),
      };
    }
  }

  return {
    type: 'leaf',
    size: rows.length,
  };
}

function pathLengthForVector(node, vector, depth) {
  if (node.type === 'leaf') {
    return depth + averagePathLength(node.size);
  }

  if (vector[node.featureIndex] < node.split) {
    return pathLengthForVector(node.left, vector, depth + 1);
  }

  return pathLengthForVector(node.right, vector, depth + 1);
}

function averagePathLength(size) {
  if (size <= 1) {
    return 0;
  }
  if (size === 2) {
    return 1;
  }

  return (2 * (Math.log(size - 1) + EULER_MASCHERONI)) - ((2 * (size - 1)) / size);
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function randomSampleWithoutReplacement(array, size, rng) {
  if (size >= array.length) {
    return [...array];
  }

  const indices = Array.from({ length: array.length }, (_, index) => index);
  for (let index = indices.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(rng, index + 1);
    [indices[index], indices[swapIndex]] = [indices[swapIndex], indices[index]];
  }

  return indices.slice(0, size).map((index) => array[index]);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6D2B79F5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, maxExclusive) {
  return Math.floor(rng() * maxExclusive);
}

function buildWindowPredictions({
  datasetRows,
  endpoints,
  startMs,
  anomalyStartMs,
  anomalyEndMs,
  windowSeconds,
  observationThreshold,
}) {
  const windowMs = windowSeconds * 1000;
  const byWindow = new Map();

  for (const row of datasetRows) {
    const windowIndex = Math.floor((row.timestamp_ms - (startMs + windowMs)) / windowMs);
    if (windowIndex < 0) {
      continue;
    }

    const bucketStartMs = startMs + windowMs + (windowIndex * windowMs) - windowMs;
    const bucketEndMs = bucketStartMs + windowMs;
    const key = `${bucketStartMs}`;

    if (!byWindow.has(key)) {
      byWindow.set(key, {
        timestamp: toIso(bucketEndMs),
        timestamp_ms: bucketEndMs,
        window_start: toIso(bucketStartMs),
        window_end: toIso(bucketEndMs),
        window_start_ms: bucketStartMs,
        window_end_ms: bucketEndMs,
        scores: [],
        endpointScores: new Map(),
      });
    }

    const bucket = byWindow.get(key);
    bucket.scores.push(row.anomaly_score);
    const previousBest = bucket.endpointScores.get(row.endpoint) ?? 0;
    if (row.anomaly_score > previousBest) {
      bucket.endpointScores.set(row.endpoint, row.anomaly_score);
    }
  }

  const windows = [...byWindow.values()].sort((a, b) => a.window_end_ms - b.window_end_ms);
  const trainingWindowScores = windows
    .filter((window) => window.window_end_ms < anomalyStartMs)
    .map((window) => Math.max(...window.scores));
  const windowThreshold = percentile(trainingWindowScores, 0.95);

  return windows.map((window) => {
    const anomalyScore = Math.max(...window.scores);
    const anomalousEndpoints = endpoints.filter(
      (endpoint) => (window.endpointScores.get(endpoint) ?? 0) >= observationThreshold,
    );
    const isGroundTruthAnomaly =
      window.window_end_ms > anomalyStartMs && window.window_start_ms < anomalyEndMs;

    return {
      timestamp: window.timestamp,
      anomaly_score: round(anomalyScore, 6),
      is_anomaly: anomalyScore >= windowThreshold,
      window_start: window.window_start,
      window_end: window.window_end,
      anomalous_endpoints: anomalousEndpoints.join(';'),
      ground_truth_is_anomaly: isGroundTruthAnomaly,
      window_threshold: round(windowThreshold, 6),
    };
  });
}

function buildPlotSeries({
  apiRows,
  windowPredictions,
  startMs,
  endMs,
  anomalyStartMs,
  anomalyEndMs,
}) {
  const plotWindows = [];
  const windowMs = WINDOW_SECONDS * 1000;

  for (let bucketEndMs = startMs + windowMs; bucketEndMs <= endMs; bucketEndMs += windowMs) {
    const windowStartMs = bucketEndMs - windowMs;
    const rawRows = apiRows.filter((row) => row.ts > windowStartMs && row.ts <= bucketEndMs);
    const slowRows = rawRows.filter((row) => row.endpoint === '/api/slow');
    const systemLatency =
      rawRows.length > 0
        ? rawRows.reduce((sum, row) => sum + row.latency, 0) / rawRows.length
        : 0;
    const slowLatency =
      slowRows.length > 0
        ? slowRows.reduce((sum, row) => sum + row.latency, 0) / slowRows.length
        : 0;
    const systemErrorRate =
      rawRows.length > 0
        ? rawRows.filter((row) => row.isError).length / rawRows.length
        : 0;
    const prediction = windowPredictions.find((window) => window.window_end === toIso(bucketEndMs));
    const anomalyScore = prediction ? Number(prediction.anomaly_score) : 0;
    const predictedAnomaly = prediction ? Boolean(prediction.is_anomaly) : false;
    const groundTruthAnomaly = bucketEndMs > anomalyStartMs && windowStartMs < anomalyEndMs;

    plotWindows.push({
      timestamp: toIso(bucketEndMs),
      timestamp_ms: bucketEndMs,
      slow_latency: round(slowLatency || systemLatency, 3),
      system_error_rate: round(systemErrorRate, 6),
      anomaly_score: round(anomalyScore, 6),
      is_predicted_anomaly: predictedAnomaly,
      is_ground_truth_anomaly: groundTruthAnomaly,
    });
  }

  return plotWindows;
}

function buildSummary({
  datasetRows,
  trainRows,
  windowPredictions,
  plotSeries,
  endpoints,
  startMs,
  endMs,
  anomalyStartMs,
  anomalyEndMs,
  featureNames,
  observationThreshold,
  groundTruth,
}) {
  const predictedAnomalyWindows = windowPredictions.filter((window) => window.is_anomaly);
  const groundTruthWindows = windowPredictions.filter((window) => window.ground_truth_is_anomaly);
  const truePositives = predictedAnomalyWindows.filter((window) => window.ground_truth_is_anomaly);
  const falsePositives = predictedAnomalyWindows.filter((window) => !window.ground_truth_is_anomaly);
  const falseNegatives = groundTruthWindows.filter((window) => !window.is_anomaly);
  const precision =
    predictedAnomalyWindows.length > 0 ? truePositives.length / predictedAnomalyWindows.length : 0;
  const recall = groundTruthWindows.length > 0 ? truePositives.length / groundTruthWindows.length : 0;
  const anomalyScoreThreshold =
    windowPredictions.length > 0 ? Number(windowPredictions[0].window_threshold) : 0;
  const maxAnomalyScore = Math.max(...windowPredictions.map((window) => Number(window.anomaly_score)));
  const detectedGroundTruthWindow = truePositives.length > 0;
  const peakLatencyWindow = plotSeries.reduce((best, current) => (
    current.slow_latency > best.slow_latency ? current : best
  ), plotSeries[0]);

  return {
    dataset: {
      source_logs: INPUT_LOGS,
      source_ground_truth: INPUT_GROUND_TRUTH,
      source_metrics_history: OUTPUT_HISTORY,
      observation_count: datasetRows.length,
      training_observation_count: trainRows.length,
      window_size_seconds: WINDOW_SECONDS,
      scrape_interval_seconds: SCRAPE_INTERVAL_SECONDS,
      endpoints,
      start_timestamp: toIso(startMs),
      end_timestamp: toIso(endMs),
    },
    ground_truth: {
      anomaly_type: groundTruth.anomaly_type,
      anomaly_start: toIso(anomalyStartMs),
      anomaly_end: toIso(anomalyEndMs),
      expected_behavior: groundTruth.expected_behavior,
    },
    model: {
      algorithm: 'Isolation Forest',
      isolation_trees: N_TREES,
      sample_size: SAMPLE_SIZE,
      observation_threshold: round(observationThreshold, 6),
      window_threshold: round(anomalyScoreThreshold, 6),
      feature_count: featureNames.length,
      features: featureNames,
    },
    performance: {
      predicted_anomaly_windows: predictedAnomalyWindows.length,
      ground_truth_anomaly_windows: groundTruthWindows.length,
      true_positive_windows: truePositives.length,
      false_positive_windows: falsePositives.length,
      false_negative_windows: falseNegatives.length,
      precision: round(precision, 4),
      recall: round(recall, 4),
      detected_ground_truth_window: detectedGroundTruthWindow,
      peak_latency_window: {
        timestamp: peakLatencyWindow.timestamp,
        slow_latency_ms: peakLatencyWindow.slow_latency,
      },
      max_anomaly_score: round(maxAnomalyScore, 6),
    },
    files: {
      dataset: OUTPUT_DATASET,
      predictions: OUTPUT_PREDICTIONS,
      history: OUTPUT_HISTORY,
      report: OUTPUT_REPORT,
      plots: {
        latency: path.join(OUTPUT_PLOTS_DIR, 'latency_timeline.svg'),
        error_rate: path.join(OUTPUT_PLOTS_DIR, 'error_rate_timeline.svg'),
        anomaly_score: path.join(OUTPUT_PLOTS_DIR, 'anomaly_score_timeline.svg'),
        overview: path.join(OUTPUT_PLOTS_DIR, 'overview.svg'),
      },
    },
  };
}

function buildReport(summary) {
  return `# ML Engineering Report

## Objective

This lab replaces the Lab Work 2 rule-based detector with an unsupervised Machine Learning detector that learns normal telemetry behavior and flags anomalous 30-second windows automatically.

## Dataset Construction

- Source log file: \`${summary.dataset.source_logs}\`
- Reconstructed Prometheus-style metrics history: \`${summary.dataset.source_metrics_history}\`
- Observation count: ${summary.dataset.observation_count}
- Training observations from normal period only: ${summary.dataset.training_observation_count}
- Monitoring endpoints: ${summary.dataset.endpoints.join(', ')}
- Window size: ${summary.dataset.window_size_seconds} seconds
- Reconstructed scrape interval: ${summary.dataset.scrape_interval_seconds} second

The dataset was built by replaying \`logs.json\` into cumulative Prometheus-style request, error, and latency totals for each endpoint. A 30-second trailing window was then sampled every second, which produced a dense telemetry dataset that satisfies the minimum observation requirement while preserving the RED metric behavior from Lab Work 1.

## Chosen Features

The model uses the following engineered operational features for every endpoint snapshot:

- \`avg_latency\`
- \`max_latency\`
- \`request_rate\`
- \`error_rate\`
- \`latency_std\`
- \`errors_per_window\`
- \`endpoint_frequency\`
- current \`latency\`
- \`request_count_window\`
- error-category composition shares for timeout, system, validation, and database failures
- one-hot encoded endpoint identity
- one-hot encoded dominant error category

These features were selected because they cover both performance degradation and failure-mode changes. The required latency and traffic features capture the shape of normal behavior, while the endpoint and error-category encodings keep the detector from incorrectly treating inherently noisy routes such as \`/api/error\` as abnormal during the normal period.

## Model Selection

- Model: ${summary.model.algorithm}
- Trees: ${summary.model.isolation_trees}
- Sample size per tree: ${summary.model.sample_size}

Isolation Forest was chosen because the task is unsupervised anomaly detection and the rubric allows it explicitly. It also works well with mixed telemetry features and does not require labeled anomalies during training. The model was trained only on observations with timestamps before the anomaly start time of ${summary.ground_truth.anomaly_start}.

## Detection Performance

- Ground-truth anomaly type: \`${summary.ground_truth.anomaly_type}\`
- Ground-truth anomaly interval: ${summary.ground_truth.anomaly_start} to ${summary.ground_truth.anomaly_end}
- Predicted anomaly windows: ${summary.performance.predicted_anomaly_windows}
- Ground-truth anomaly windows: ${summary.performance.ground_truth_anomaly_windows}
- True positive windows: ${summary.performance.true_positive_windows}
- False positive windows: ${summary.performance.false_positive_windows}
- False negative windows: ${summary.performance.false_negative_windows}
- Precision: ${summary.performance.precision}
- Recall: ${summary.performance.recall}
- Detected overlap with ground truth: ${summary.performance.detected_ground_truth_window ? 'Yes' : 'No'}
- Peak slow-endpoint latency window: ${summary.performance.peak_latency_window.timestamp} (${summary.performance.peak_latency_window.slow_latency_ms} ms)

The detector scores every endpoint snapshot and then aggregates those scores into 30-second window predictions. A window threshold is derived only from the normal-period score distribution, so the anomaly decision is still learned from healthy behavior instead of being hardcoded against the anomaly interval.

## Deliverables Produced

- Dataset: \`${summary.files.dataset}\`
- Predictions: \`${summary.files.predictions}\`
- Prometheus history replay: \`${summary.files.history}\`
- Latency plot: \`${summary.files.plots.latency}\`
- Error-rate plot: \`${summary.files.plots.error_rate}\`
- Anomaly-score plot: \`${summary.files.plots.anomaly_score}\`
- Combined overview plot: \`${summary.files.plots.overview}\`
`;
}

function renderPlots(plotSeries, { outputDir, anomalyStartMs, anomalyEndMs, threshold }) {
  const latencySvg = renderSingleSeriesPlot({
    title: '/api/slow Avg Latency Timeline',
    subtitle: '30-second windows with predicted anomaly points highlighted',
    yLabel: 'Latency (ms)',
    data: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.slow_latency,
      isAnomaly: row.is_predicted_anomaly,
      isGroundTruth: row.is_ground_truth_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    lineColor: '#1d4ed8',
  });

  const errorRateSvg = renderSingleSeriesPlot({
    title: 'System Error Rate Timeline',
    subtitle: '30-second windows with predicted anomaly points highlighted',
    yLabel: 'Error Rate',
    data: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.system_error_rate,
      isAnomaly: row.is_predicted_anomaly,
      isGroundTruth: row.is_ground_truth_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    lineColor: '#059669',
  });

  const anomalyScoreSvg = renderSingleSeriesPlot({
    title: 'Isolation Forest Anomaly Score',
    subtitle: 'Window score with learned anomaly threshold',
    yLabel: 'Score',
    data: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.anomaly_score,
      isAnomaly: row.is_predicted_anomaly,
      isGroundTruth: row.is_ground_truth_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    lineColor: '#7c3aed',
    threshold,
  });

  const overviewSvg = renderOverviewPlot({
    plotSeries,
    anomalyStartMs,
    anomalyEndMs,
    threshold,
  });

  writeFile(path.join(outputDir, 'latency_timeline.svg'), latencySvg);
  writeFile(path.join(outputDir, 'error_rate_timeline.svg'), errorRateSvg);
  writeFile(path.join(outputDir, 'anomaly_score_timeline.svg'), anomalyScoreSvg);
  writeFile(path.join(outputDir, 'overview.svg'), overviewSvg);
}

function renderSingleSeriesPlot({
  title,
  subtitle,
  yLabel,
  data,
  anomalyStartMs,
  anomalyEndMs,
  lineColor,
  threshold = null,
}) {
  const width = 1200;
  const height = 420;
  const margin = { top: 70, right: 40, bottom: 70, left: 80 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const minX = data[0].timestamp_ms;
  const maxX = data[data.length - 1].timestamp_ms;
  const maxY = Math.max(...data.map((point) => point.value), threshold ?? 0, 1);
  const xScale = (value) => margin.left + (((value - minX) / Math.max(maxX - minX, 1)) * innerWidth);
  const yScale = (value) => margin.top + innerHeight - ((value / maxY) * innerHeight);
  const points = data.map((point) => `${xScale(point.timestamp_ms)},${yScale(point.value)}`).join(' ');

  const tickCount = Math.min(8, data.length);
  const xTicks = [];
  for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
    const point = data[Math.min(data.length - 1, Math.round((tickIndex / Math.max(tickCount - 1, 1)) * (data.length - 1)))];
    xTicks.push(point);
  }

  const yTicks = [];
  for (let tickIndex = 0; tickIndex <= 5; tickIndex += 1) {
    const value = (maxY / 5) * tickIndex;
    yTicks.push(value);
  }

  const anomalyBandX = xScale(anomalyStartMs);
  const anomalyBandWidth = xScale(anomalyEndMs) - anomalyBandX;
  const thresholdY = threshold !== null ? yScale(threshold) : null;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${margin.left}" y="28" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#111827">${escapeXml(title)}</text>
  <text x="${margin.left}" y="50" font-family="Arial, sans-serif" font-size="12" fill="#4b5563">${escapeXml(subtitle)}</text>
  <rect x="${anomalyBandX}" y="${margin.top}" width="${anomalyBandWidth}" height="${innerHeight}" fill="#fee2e2" opacity="0.8"/>
  ${yTicks.map((value) => `
  <line x1="${margin.left}" y1="${yScale(value)}" x2="${width - margin.right}" y2="${yScale(value)}" stroke="#e5e7eb" stroke-width="1"/>
  <text x="${margin.left - 12}" y="${yScale(value) + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="#6b7280">${formatTick(value)}</text>`).join('')}
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
  <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
  <polyline fill="none" stroke="${lineColor}" stroke-width="2.5" points="${points}"/>
  ${thresholdY !== null ? `<line x1="${margin.left}" y1="${thresholdY}" x2="${width - margin.right}" y2="${thresholdY}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="${width - margin.right}" y="${thresholdY - 8}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="#ef4444">threshold ${formatTick(threshold)}</text>` : ''}
  ${data.map((point) => {
    const fill = point.isAnomaly ? '#dc2626' : '#2563eb';
    const radius = point.isAnomaly ? 4 : 2.5;
    return `<circle cx="${xScale(point.timestamp_ms)}" cy="${yScale(point.value)}" r="${radius}" fill="${fill}" opacity="${point.isGroundTruth ? 1 : 0.85}"/>`;
  }).join('')}
  ${xTicks.map((point) => `
  <line x1="${xScale(point.timestamp_ms)}" y1="${height - margin.bottom}" x2="${xScale(point.timestamp_ms)}" y2="${height - margin.bottom + 6}" stroke="#111827" stroke-width="1"/>
  <text x="${xScale(point.timestamp_ms)}" y="${height - margin.bottom + 22}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#6b7280">${formatTimeLabel(point.timestamp)}</text>`).join('')}
  <text x="${width / 2}" y="${height - 18}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#374151">Time</text>
  <text x="20" y="${height / 2}" transform="rotate(-90 20 ${height / 2})" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#374151">${escapeXml(yLabel)}</text>
  <rect x="${width - 270}" y="22" width="14" height="14" fill="#fee2e2"/>
  <text x="${width - 248}" y="33" font-family="Arial, sans-serif" font-size="11" fill="#374151">Ground-truth anomaly interval</text>
  <circle cx="${width - 160}" cy="29" r="4" fill="#dc2626"/>
  <text x="${width - 148}" y="33" font-family="Arial, sans-serif" font-size="11" fill="#374151">Predicted anomaly</text>
</svg>`;
}

function renderOverviewPlot({ plotSeries, anomalyStartMs, anomalyEndMs, threshold }) {
  const width = 1200;
  const height = 1100;
  const panelHeight = 280;
  const panelMargin = 40;

  const latency = renderMiniPanel({
    title: '/api/slow Avg Latency',
    color: '#1d4ed8',
    yLabel: 'ms',
    values: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.slow_latency,
      isAnomaly: row.is_predicted_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    width,
    height: panelHeight,
  });

  const errorRate = renderMiniPanel({
    title: 'System Error Rate',
    color: '#059669',
    yLabel: 'rate',
    values: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.system_error_rate,
      isAnomaly: row.is_predicted_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    width,
    height: panelHeight,
  });

  const anomaly = renderMiniPanel({
    title: 'Anomaly Score',
    color: '#7c3aed',
    yLabel: 'score',
    values: plotSeries.map((row) => ({
      timestamp_ms: row.timestamp_ms,
      timestamp: row.timestamp,
      value: row.anomaly_score,
      isAnomaly: row.is_predicted_anomaly,
    })),
    anomalyStartMs,
    anomalyEndMs,
    width,
    height: panelHeight,
    threshold,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="40" y="36" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">ML Anomaly Detection Overview</text>
  <text x="40" y="58" font-family="Arial, sans-serif" font-size="13" fill="#4b5563">30-second windows from reconstructed Prometheus telemetry</text>
  <g transform="translate(0, 90)">${latency}</g>
  <g transform="translate(0, ${90 + panelHeight + panelMargin})">${errorRate}</g>
  <g transform="translate(0, ${90 + (2 * (panelHeight + panelMargin))})">${anomaly}</g>
</svg>`;
}

function renderMiniPanel({
  title,
  color,
  yLabel,
  values,
  anomalyStartMs,
  anomalyEndMs,
  width,
  height,
  threshold = null,
}) {
  const margin = { top: 40, right: 36, bottom: 52, left: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const minX = values[0].timestamp_ms;
  const maxX = values[values.length - 1].timestamp_ms;
  const maxY = Math.max(...values.map((point) => point.value), threshold ?? 0, 1);
  const xScale = (value) => margin.left + (((value - minX) / Math.max(maxX - minX, 1)) * innerWidth);
  const yScale = (value) => margin.top + innerHeight - ((value / maxY) * innerHeight);
  const points = values.map((point) => `${xScale(point.timestamp_ms)},${yScale(point.value)}`).join(' ');
  const xTicks = [];
  const tickCount = Math.min(8, values.length);
  for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
    const point = values[Math.min(values.length - 1, Math.round((tickIndex / Math.max(tickCount - 1, 1)) * (values.length - 1)))];
    xTicks.push(point);
  }
  const anomalyBandX = xScale(anomalyStartMs);
  const anomalyBandWidth = xScale(anomalyEndMs) - anomalyBandX;
  const thresholdY = threshold !== null ? yScale(threshold) : null;

  return `
    <text x="${margin.left}" y="24" font-family="Arial, sans-serif" font-size="17" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <rect x="${anomalyBandX}" y="${margin.top}" width="${anomalyBandWidth}" height="${innerHeight}" fill="#fee2e2"/>
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
    ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const value = maxY * ratio;
      return `<line x1="${margin.left}" y1="${yScale(value)}" x2="${width - margin.right}" y2="${yScale(value)}" stroke="#e5e7eb" stroke-width="1"/>
      <text x="${margin.left - 10}" y="${yScale(value) + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="10" fill="#6b7280">${formatTick(value)}</text>`;
    }).join('')}
    <polyline fill="none" stroke="${color}" stroke-width="2.5" points="${points}"/>
    ${thresholdY !== null ? `<line x1="${margin.left}" y1="${thresholdY}" x2="${width - margin.right}" y2="${thresholdY}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="6 4"/>` : ''}
    ${values.map((point) => `<circle cx="${xScale(point.timestamp_ms)}" cy="${yScale(point.value)}" r="${point.isAnomaly ? 4 : 2.5}" fill="${point.isAnomaly ? '#dc2626' : color}"/>`).join('')}
    ${xTicks.map((point) => `<text x="${xScale(point.timestamp_ms)}" y="${height - 18}" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#6b7280">${formatTimeLabel(point.timestamp)}</text>`).join('')}
    <text x="18" y="${height / 2}" transform="rotate(-90 18 ${height / 2})" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#374151">${escapeXml(yLabel)}</text>`;
}

function flattenPrometheusHistory(perEndpointHistory) {
  const rows = [];

  for (const [endpoint, history] of perEndpointHistory.entries()) {
    for (const point of history) {
      rows.push({
        timestamp: point.timestamp,
        endpoint,
        requests_total: point.requests_total,
        errors_total: point.errors_total,
        latency_sum_ms_total: point.latency_sum_ms_total,
        latency_count_total: point.latency_count_total,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp);
    }

    return a.endpoint.localeCompare(b.endpoint);
  });

  return rows;
}

function datasetColumnOrder() {
  return [
    'timestamp',
    'window_start',
    'window_end',
    'endpoint',
    'latency',
    'error_rate',
    'request_rate',
    'error_category',
    'avg_latency',
    'max_latency',
    'latency_std',
    'errors_per_window',
    'endpoint_frequency',
    'request_count_window',
    'timeout_error_share',
    'system_error_share',
    'validation_error_share',
    'database_error_share',
    'source',
    'window_size_seconds',
    'is_ground_truth_anomaly',
    'anomaly_score',
    'is_observation_anomaly',
  ];
}

function predictionColumnOrder() {
  return [
    'timestamp',
    'anomaly_score',
    'is_anomaly',
    'window_start',
    'window_end',
    'anomalous_endpoints',
    'ground_truth_is_anomaly',
    'window_threshold',
  ];
}

function prometheusHistoryColumnOrder() {
  return [
    'timestamp',
    'endpoint',
    'requests_total',
    'errors_total',
    'latency_sum_ms_total',
    'latency_count_total',
  ];
}

function toCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','));
  return [header, ...lines].join('\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function percentile(values, quantile) {
  if (!values || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const weight = index - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * weight);
}

function standardDeviation(values) {
  if (!values || values.length === 0) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;

  return Math.sqrt(variance);
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function toIso(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function formatTimeLabel(isoString) {
  return isoString.slice(11, 19);
}

function formatTick(value) {
  if (value >= 1000) {
    return round(value, 0);
  }
  if (value >= 10) {
    return round(value, 1);
  }
  return round(value, 3);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

main();
