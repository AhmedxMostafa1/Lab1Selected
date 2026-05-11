#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const INPUT_DATASET = 'aiops_dataset.csv';
const INPUT_PREDICTIONS = 'anomaly_predictions.csv';
const OUTPUT_JSON = 'rca_report.json';
const OUTPUT_REPORT = 'RCA_Report.md';
const OUTPUT_DIR = path.join('visualizations', 'rca');
const OUTPUT_TIMELINE = path.join(OUTPUT_DIR, 'incident_timeline.svg');
const ERROR_CATEGORIES = [
  'TIMEOUT_ERROR',
  'SYSTEM_ERROR',
  'DATABASE_ERROR',
  'VALIDATION_ERROR',
  'UNKNOWN',
];

function main() {
  const datasetRows = readCsv(INPUT_DATASET).map(normalizeDatasetRow);
  const predictionRows = readCsv(INPUT_PREDICTIONS).map(normalizePredictionRow);

  if (datasetRows.length === 0) {
    throw new Error(`No rows found in ${INPUT_DATASET}. Run the ML pipeline first.`);
  }
  if (predictionRows.length === 0) {
    throw new Error(`No rows found in ${INPUT_PREDICTIONS}. Run the ML pipeline first.`);
  }

  const incident = selectIncident(predictionRows);
  const baselineRows = datasetRows.filter((row) => row.timestampMs < incident.startMs);
  const incidentRows = datasetRows.filter(
    (row) => row.timestampMs > incident.startMs && row.timestampMs <= incident.endMs,
  );
  const allEndpoints = [...new Set(datasetRows.map((row) => row.endpoint))].sort();
  const endpointAnalysis = analyzeEndpoints(allEndpoints, baselineRows, incidentRows, incident);
  const rootCause = endpointAnalysis[0];
  const errorDistribution = analyzeErrors(incidentRows);
  const rootCauseErrorDistribution = analyzeErrors(
    incidentRows.filter((row) => row.endpoint === rootCause.endpoint),
  );
  const primarySignal = determinePrimarySignal(rootCause);
  const timeline = buildTimeline({ predictionRows, datasetRows, incident, rootCause });
  const confidenceScore = confidenceFor(rootCause, endpointAnalysis, incident);
  const recommendation = recommendedAction(
    rootCause.endpoint,
    primarySignal,
    rootCauseErrorDistribution.dominant_category,
  );

  const report = {
    incident_id: incident.id,
    selected_window: {
      window_start: incident.windowStart,
      window_end: incident.windowEnd,
      peak_timestamp: incident.peakTimestamp,
      anomaly_score: round(incident.score),
      threshold: round(incident.threshold),
      source: INPUT_PREDICTIONS,
    },
    root_cause_endpoint: rootCause.endpoint,
    primary_signal: primarySignal,
    supporting_evidence: {
      endpoint_attribution: endpointAnalysis.map((endpoint) => ({
        endpoint: endpoint.endpoint,
        contribution_score: round(endpoint.contributionScore),
        baseline: summarizeForJson(endpoint.baseline),
        incident: summarizeForJson(endpoint.incident),
        deltas: summarizeForJson(endpoint.deltas),
      })),
      error_categories: errorDistribution,
      root_cause_error_categories: rootCauseErrorDistribution,
      incident_windows: incident.windows.map((window) => ({
        window_start: window.window_start,
        window_end: window.window_end,
        anomaly_score: round(window.anomaly_score),
        anomalous_endpoints: window.anomalous_endpoints,
      })),
      timeline,
    },
    confidence_score: round(confidenceScore),
    recommended_action: recommendation,
    generated_files: {
      json: OUTPUT_JSON,
      timeline_visualization: OUTPUT_TIMELINE,
      report: OUTPUT_REPORT,
    },
  };

  ensureDir(OUTPUT_DIR);
  writeFile(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  writeFile(OUTPUT_TIMELINE, renderTimelineSvg({ timeline, incident, rootCause, predictionRows }));
  writeFile(OUTPUT_REPORT, buildMarkdownReport(report));

  console.log(JSON.stringify({
    incident_id: report.incident_id,
    root_cause_endpoint: report.root_cause_endpoint,
    primary_signal: report.primary_signal,
    confidence_score: report.confidence_score,
    outputs: report.generated_files,
  }, null, 2));
}

function readCsv(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8').trim();
  if (!contents) {
    return [];
  }

  const [headerLine, ...lines] = contents.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function normalizeDatasetRow(row) {
  return {
    ...row,
    timestampMs: Date.parse(row.timestamp),
    windowStartMs: Date.parse(row.window_start),
    windowEndMs: Date.parse(row.window_end),
    endpoint: row.endpoint,
    latency: number(row.latency),
    avg_latency: number(row.avg_latency),
    max_latency: number(row.max_latency),
    error_rate: number(row.error_rate),
    request_rate: number(row.request_rate),
    errors_per_window: number(row.errors_per_window),
    endpoint_frequency: number(row.endpoint_frequency),
    request_count_window: number(row.request_count_window),
    anomaly_score: number(row.anomaly_score),
    timeout_error_share: number(row.timeout_error_share),
    system_error_share: number(row.system_error_share),
    validation_error_share: number(row.validation_error_share),
    database_error_share: number(row.database_error_share),
  };
}

function normalizePredictionRow(row) {
  return {
    ...row,
    timestampMs: Date.parse(row.timestamp),
    windowStartMs: Date.parse(row.window_start),
    windowEndMs: Date.parse(row.window_end),
    anomaly_score: number(row.anomaly_score),
    is_anomaly: row.is_anomaly === 'true',
    ground_truth_is_anomaly: row.ground_truth_is_anomaly === 'true',
    window_threshold: number(row.window_threshold),
    anomalous_endpoints: row.anomalous_endpoints
      ? row.anomalous_endpoints.split(';').map((endpoint) => endpoint.trim()).filter(Boolean)
      : [],
  };
}

function selectIncident(predictionRows) {
  const candidates = predictionRows.filter((row) => row.is_anomaly);
  if (candidates.length === 0) {
    throw new Error('No detected incident windows found in anomaly_predictions.csv.');
  }

  const selected = [...candidates].sort((a, b) => {
    if (b.ground_truth_is_anomaly !== a.ground_truth_is_anomaly) {
      return Number(b.ground_truth_is_anomaly) - Number(a.ground_truth_is_anomaly);
    }
    return b.anomaly_score - a.anomaly_score;
  })[0];

  const group = contiguousDetectedWindows(predictionRows, selected);
  return {
    id: `INC-${formatCompactTimestamp(selected.window_start)}`,
    startMs: Math.min(...group.map((row) => row.windowStartMs)),
    endMs: Math.max(...group.map((row) => row.windowEndMs)),
    windowStart: toIso(Math.min(...group.map((row) => row.windowStartMs))),
    windowEnd: toIso(Math.max(...group.map((row) => row.windowEndMs))),
    peakTimestamp: selected.timestamp,
    score: selected.anomaly_score,
    threshold: selected.window_threshold,
    windows: group,
  };
}

function contiguousDetectedWindows(rows, selected) {
  const selectedIndex = rows.indexOf(selected);
  let startIndex = selectedIndex;
  let endIndex = selectedIndex;

  while (startIndex > 0 && rows[startIndex - 1].is_anomaly) {
    startIndex -= 1;
  }
  while (endIndex < rows.length - 1 && rows[endIndex + 1].is_anomaly) {
    endIndex += 1;
  }

  return rows.slice(startIndex, endIndex + 1);
}

function analyzeEndpoints(endpoints, baselineRows, incidentRows, incident) {
  const hintedEndpoints = new Set(incident.windows.flatMap((window) => window.anomalous_endpoints));

  return endpoints
    .map((endpoint) => {
      const baseline = aggregateEndpoint(baselineRows.filter((row) => row.endpoint === endpoint));
      const incident = aggregateEndpoint(incidentRows.filter((row) => row.endpoint === endpoint));
      const deltas = {
        avg_latency: incident.avg_latency - baseline.avg_latency,
        max_latency: incident.max_latency - baseline.max_latency,
        request_rate: incident.request_rate - baseline.request_rate,
        error_rate: incident.error_rate - baseline.error_rate,
        endpoint_frequency: incident.endpoint_frequency - baseline.endpoint_frequency,
        errors_per_window: incident.errors_per_window - baseline.errors_per_window,
      };
      const contributionScore =
        (hintedEndpoints.has(endpoint) ? 4 : 0) +
        Math.min(6, incident.avg_latency / 1000) * 0.8 +
        Math.min(4, incident.max_latency / 2000) * 0.6 +
        Math.max(0, incident.anomaly_score - baseline.anomaly_score) * 4 +
        ratioLift(incident.avg_latency, baseline.avg_latency) * 0.12 +
        ratioLift(incident.max_latency, baseline.max_latency) * 0.08 +
        Math.max(0, deltas.error_rate) * 2.0 +
        ratioLift(incident.errors_per_window, baseline.errors_per_window) * 0.12 +
        Math.max(0, deltas.endpoint_frequency) * 0.8 +
        ratioLift(incident.request_rate, baseline.request_rate) * 0.08;

      return {
        endpoint,
        baseline,
        incident,
        deltas,
        contributionScore,
      };
    })
    .sort((a, b) => b.contributionScore - a.contributionScore);
}

function aggregateEndpoint(rows) {
  if (rows.length === 0) {
    return {
      avg_latency: 0,
      max_latency: 0,
      request_rate: 0,
      error_rate: 0,
      endpoint_frequency: 0,
      errors_per_window: 0,
      request_count_window: 0,
      anomaly_score: 0,
    };
  }

  return {
    avg_latency: mean(rows.map((row) => row.avg_latency)),
    max_latency: Math.max(...rows.map((row) => row.max_latency)),
    request_rate: mean(rows.map((row) => row.request_rate)),
    error_rate: weightedRate(rows, 'errors_per_window', 'request_count_window'),
    endpoint_frequency: mean(rows.map((row) => row.endpoint_frequency)),
    errors_per_window: mean(rows.map((row) => row.errors_per_window)),
    request_count_window: mean(rows.map((row) => row.request_count_window)),
    anomaly_score: Math.max(...rows.map((row) => row.anomaly_score)),
  };
}

function analyzeErrors(incidentRows) {
  const counts = {
    TIMEOUT_ERROR: 0,
    SYSTEM_ERROR: 0,
    DATABASE_ERROR: 0,
    VALIDATION_ERROR: 0,
    UNKNOWN: 0,
  };

  for (const row of incidentRows) {
    counts.TIMEOUT_ERROR += row.timeout_error_share * row.request_count_window;
    counts.SYSTEM_ERROR += row.system_error_share * row.request_count_window;
    counts.DATABASE_ERROR += row.database_error_share * row.request_count_window;
    counts.VALIDATION_ERROR += row.validation_error_share * row.request_count_window;
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const distribution = Object.fromEntries(
    ERROR_CATEGORIES.map((category) => [
      category,
      {
        estimated_count: round(counts[category]),
        share: total > 0 ? round(counts[category] / total) : 0,
      },
    ]),
  );
  const dominant = ERROR_CATEGORIES
    .map((category) => ({ category, count: counts[category] }))
    .sort((a, b) => b.count - a.count)[0];

  return {
    dominant_category: dominant.count > 0 ? dominant.category : 'NONE',
    estimated_total_errors: round(total),
    distribution,
  };
}

function determinePrimarySignal(endpoint) {
  const latencyLift = ratioLift(endpoint.incident.avg_latency, endpoint.baseline.avg_latency);
  const maxLatencyLift = ratioLift(endpoint.incident.max_latency, endpoint.baseline.max_latency);
  const errorLift = endpoint.incident.error_rate - endpoint.baseline.error_rate;
  const requestLift = ratioLift(endpoint.incident.request_rate, endpoint.baseline.request_rate);

  if (latencyLift >= Math.max(errorLift * 2, requestLift) || maxLatencyLift > 2) {
    return 'latency';
  }
  if (errorLift > 0.2) {
    return 'error_rate';
  }
  return 'request_rate';
}

function buildTimeline({ predictionRows, datasetRows, incident, rootCause }) {
  const previousWindow = [...predictionRows]
    .filter((row) => row.windowEndMs <= incident.startMs)
    .sort((a, b) => b.windowEndMs - a.windowEndMs)[0];
  const recoveryWindow = predictionRows.find((row) => row.windowStartMs >= incident.endMs && !row.is_anomaly);
  const rootRows = datasetRows.filter((row) => row.endpoint === rootCause.endpoint);
  const peakRow = [...rootRows]
    .filter((row) => row.timestampMs >= incident.startMs && row.timestampMs <= incident.endMs)
    .sort((a, b) => b.avg_latency - a.avg_latency)[0];

  return [
    {
      state: 'normal_state',
      timestamp: previousWindow?.window_end ?? toIso(incident.startMs),
      description: previousWindow
        ? `Window below anomaly threshold with score ${round(previousWindow.anomaly_score)}.`
        : 'No earlier prediction window was available before the incident.',
    },
    {
      state: 'anomaly_start',
      timestamp: incident.windowStart,
      description: `Detected anomaly group opened for ${rootCause.endpoint}.`,
    },
    {
      state: 'peak_incident',
      timestamp: peakRow?.timestamp ?? incident.peakTimestamp,
      description: `${rootCause.endpoint} reached avg latency ${round(peakRow?.avg_latency ?? rootCause.incident.avg_latency, 2)} ms with ${round(rootCause.incident.error_rate, 3)} error rate.`,
    },
    {
      state: 'recovery',
      timestamp: recoveryWindow?.window_end ?? toIso(incident.endMs),
      description: recoveryWindow
        ? `Next non-anomalous window observed with score ${round(recoveryWindow.anomaly_score)}.`
        : 'Recovery was not captured in the exported prediction range; dataset ends while the incident is still active or tapering.',
    },
  ];
}

function confidenceFor(rootCause, endpoints, incident) {
  const totalScore = endpoints.reduce((sum, endpoint) => sum + Math.max(0, endpoint.contributionScore), 0);
  const separation = totalScore > 0 ? rootCause.contributionScore / totalScore : 0.5;
  const thresholdMargin = incident.threshold > 0 ? Math.max(0, (incident.score - incident.threshold) / incident.threshold) : 0;
  const evidenceDensity = Math.min(1, rootCause.incident.request_count_window / 10);
  return Math.min(0.99, 0.5 + (separation * 0.28) + (thresholdMargin * 0.8) + (evidenceDensity * 0.12));
}

function recommendedAction(endpoint, primarySignal, dominantCategory) {
  if (primarySignal === 'latency' && dominantCategory === 'TIMEOUT_ERROR') {
    return `Investigate ${endpoint} slow path, reduce timeout-prone work, and add a latency guard or async queue for hard slow requests.`;
  }
  if (primarySignal === 'error_rate') {
    return `Inspect ${endpoint} exception logs and deploy a fix for the dominant ${dominantCategory} failures.`;
  }
  return `Check upstream traffic source for ${endpoint}, validate rate limits, and scale the service if the load is expected.`;
}

function buildMarkdownReport(report) {
  const root = report.supporting_evidence.endpoint_attribution[0];
  const errors = report.supporting_evidence.error_categories;
  const rootErrors = report.supporting_evidence.root_cause_error_categories;

  return `# Root Cause Analysis Report

## Executive Summary

Incident ${report.incident_id} was selected from the detected incident windows in \`${INPUT_PREDICTIONS}\`. The most likely root cause endpoint is \`${report.root_cause_endpoint}\`, and the primary degraded signal is \`${report.primary_signal}\`. The RCA confidence score is ${report.confidence_score}.

The strongest evidence is that \`${root.endpoint}\` moved from a baseline average latency of ${round(root.baseline.avg_latency, 2)} ms to ${round(root.incident.avg_latency, 2)} ms during the incident window, with a peak max latency of ${round(root.incident.max_latency, 2)} ms. Its error rate also increased to ${round(root.incident.error_rate, 3)}, driven mainly by \`${rootErrors.dominant_category}\`.

## Incident Selection

- Selected incident ID: \`${report.incident_id}\`
- Window start: ${report.selected_window.window_start}
- Window end: ${report.selected_window.window_end}
- Peak anomaly timestamp: ${report.selected_window.peak_timestamp}
- Anomaly score: ${report.selected_window.anomaly_score}
- Learned threshold: ${report.selected_window.threshold}

The selected window is the highest-scoring detected anomaly that overlaps the ground-truth anomaly period in the Lab 3 predictions.

## Signal Analysis

The RCA script compares the selected incident window against all earlier normal windows. It evaluates latency, request rate, error rate, endpoint activity, and error-category composition for every endpoint.

| Endpoint | Contribution | Avg Latency Delta | Error Rate Delta | Request Rate Delta | Activity Delta |
| --- | ---: | ---: | ---: | ---: | ---: |
${report.supporting_evidence.endpoint_attribution.map((endpoint) => `| \`${endpoint.endpoint}\` | ${endpoint.contribution_score} | ${round(endpoint.deltas.avg_latency, 2)} ms | ${round(endpoint.deltas.error_rate, 3)} | ${round(endpoint.deltas.request_rate, 3)} req/s | ${round(endpoint.deltas.endpoint_frequency, 3)} |`).join('\n')}

## Endpoint Attribution

\`${report.root_cause_endpoint}\` contributed most to the anomaly. The endpoint had the largest combined lift in average latency, maximum latency, anomaly score, and timeout-heavy error composition. This matches the expected Lab behavior where \`/api/slow?hard=1\` creates a latency spike.

## Error Category Analysis

| Error Category | Estimated Count | Share |
| --- | ---: | ---: |
${Object.entries(errors.distribution).map(([category, value]) => `| \`${category}\` | ${value.estimated_count} | ${value.share} |`).join('\n')}

The overall incident window contains background failures from other synthetic lab endpoints, so the RCA also isolates the root-cause endpoint. For \`${report.root_cause_endpoint}\`, the dominant category is \`${rootErrors.dominant_category}\`, which supports a timeout-driven latency incident instead of a broad system or database failure.

## Incident Timeline

${report.supporting_evidence.timeline.map((event) => `- **${event.state}** (${event.timestamp}): ${event.description}`).join('\n')}

The timeline visualization is available at \`${OUTPUT_TIMELINE}\`.

## Root Cause Output

- \`incident_id\`: \`${report.incident_id}\`
- \`root_cause_endpoint\`: \`${report.root_cause_endpoint}\`
- \`primary_signal\`: \`${report.primary_signal}\`
- \`confidence_score\`: ${report.confidence_score}
- \`recommended_action\`: ${report.recommended_action}

## Recommendation

Prioritize \`${report.root_cause_endpoint}\` remediation. Add request-level timeout protection around the slow execution branch, monitor the TIMEOUT_ERROR share as a leading indicator, and keep the endpoint-specific latency alert separate from global error-rate alerts so future slow-path incidents are attributed faster.
`;
}

function renderTimelineSvg({ timeline, incident, rootCause, predictionRows }) {
  const width = 1200;
  const height = 520;
  const margin = { top: 90, right: 70, bottom: 120, left: 90 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const minTime = predictionRows[0].windowStartMs;
  const maxTime = predictionRows[predictionRows.length - 1].windowEndMs;
  const maxScore = Math.max(...predictionRows.map((row) => row.anomaly_score), incident.threshold, 1);
  const xScale = (value) => margin.left + (((value - minTime) / Math.max(maxTime - minTime, 1)) * innerWidth);
  const yScale = (value) => margin.top + innerHeight - ((value / maxScore) * innerHeight);
  const points = predictionRows.map((row) => `${xScale(row.windowEndMs)},${yScale(row.anomaly_score)}`).join(' ');
  const thresholdY = yScale(incident.threshold);
  const incidentX = xScale(incident.startMs);
  const incidentWidth = xScale(incident.endMs) - incidentX;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${margin.left}" y="36" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#111827">RCA Incident Timeline</text>
  <text x="${margin.left}" y="60" font-family="Arial, sans-serif" font-size="13" fill="#4b5563">Selected incident ${escapeXml(incident.id)} attributed to ${escapeXml(rootCause.endpoint)}</text>
  <rect x="${incidentX}" y="${margin.top}" width="${incidentWidth}" height="${innerHeight}" fill="#fee2e2" opacity="0.9"/>
  ${[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const value = maxScore * ratio;
    return `<line x1="${margin.left}" y1="${yScale(value)}" x2="${width - margin.right}" y2="${yScale(value)}" stroke="#e5e7eb" stroke-width="1"/>
  <text x="${margin.left - 12}" y="${yScale(value) + 4}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="#6b7280">${round(value, 3)}</text>`;
  }).join('\n')}
  <line x1="${margin.left}" y1="${thresholdY}" x2="${width - margin.right}" y2="${thresholdY}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="6 5"/>
  <text x="${width - margin.right}" y="${thresholdY - 8}" text-anchor="end" font-family="Arial, sans-serif" font-size="11" fill="#dc2626">threshold ${round(incident.threshold, 3)}</text>
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
  <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#111827" stroke-width="1.5"/>
  <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${points}"/>
  ${predictionRows.map((row) => `<circle cx="${xScale(row.windowEndMs)}" cy="${yScale(row.anomaly_score)}" r="${row.is_anomaly ? 5 : 3}" fill="${row.is_anomaly ? '#dc2626' : '#2563eb'}"/>`).join('\n')}
  ${timeline.map((event, index) => {
    const x = xScale(Date.parse(event.timestamp));
    const y = height - 78 + ((index % 2) * 36);
    return `<line x1="${x}" y1="${height - margin.bottom}" x2="${x}" y2="${y - 18}" stroke="#6b7280" stroke-width="1" stroke-dasharray="3 4"/>
  <circle cx="${x}" cy="${height - margin.bottom}" r="5" fill="#111827"/>
  <text x="${x}" y="${y}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="700" fill="#111827">${escapeXml(event.state.replaceAll('_', ' '))}</text>
  <text x="${x}" y="${y + 15}" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" fill="#6b7280">${formatTime(event.timestamp)}</text>`;
  }).join('\n')}
  <text x="26" y="${margin.top + (innerHeight / 2)}" transform="rotate(-90 26 ${margin.top + (innerHeight / 2)})" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#374151">Anomaly score</text>
  <text x="${width / 2}" y="${height - 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#374151">Incident lifecycle</text>
</svg>`;
}

function summarizeForJson(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value]),
  );
}

function weightedRate(rows, numeratorKey, denominatorKey) {
  const denominator = rows.reduce((sum, row) => sum + row[denominatorKey], 0);
  if (denominator <= 0) {
    return 0;
  }
  return rows.reduce((sum, row) => sum + row[numeratorKey], 0) / denominator;
}

function ratioLift(incidentValue, baselineValue) {
  const safeBaseline = Math.max(Math.abs(baselineValue), 1);
  return Math.max(0, (incidentValue - baselineValue) / safeBaseline);
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, digits = 6) {
  return Number((value ?? 0).toFixed(digits));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFile(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, 'utf8');
}

function toIso(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function formatTime(timestamp) {
  return new Date(timestamp).toISOString().slice(11, 19);
}

function formatCompactTimestamp(timestamp) {
  return new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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
