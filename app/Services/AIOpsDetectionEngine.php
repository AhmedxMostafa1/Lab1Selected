<?php

namespace App\Services;

use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class AIOpsDetectionEngine
{
    public const ENDPOINTS = [
        '/api/normal',
        '/api/slow',
        '/api/db',
        '/api/error',
        '/api/validate',
    ];

    private const HISTORY_LIMIT = 30;

    public function __construct(
        private readonly string $statePath,
        private readonly string $incidentsPath,
        private readonly string $serviceName = 'laravel-api',
        private readonly ?string $webhookUrl = null,
    ) {
    }

    /**
     * @param  array<string, array<string, mixed>>  $metrics
     * @return array<string, mixed>
     */
    public function evaluate(array $metrics, ?CarbonImmutable $detectedAt = null): array
    {
        $detectedAt ??= CarbonImmutable::now();
        $state = $this->readJsonFile($this->statePath, $this->emptyState());
        $incidents = $this->readJsonFile($this->incidentsPath, []);

        $baselines = [];
        $signalsByEndpoint = [];
        $newIncidents = [];
        $alerts = [];
        $seenFingerprints = [];

        foreach (self::ENDPOINTS as $endpoint) {
            $sample = $this->normalizeSample($metrics[$endpoint] ?? []);
            $history = $state['history'][$endpoint] ?? [];
            $baseline = $this->buildBaseline($history);
            $signals = $this->detectSignals($endpoint, $sample, $baseline, $metrics);

            $baselines[$endpoint] = $baseline;
            $signalsByEndpoint[$endpoint] = $signals;

            if ($signals === []) {
                $state['history'][$endpoint] = $this->trimHistory([
                    ...$history,
                    $this->makeHistoryRecord($sample, $detectedAt),
                ]);

                continue;
            }

            $state['history'][$endpoint] = $this->trimHistory($history);
        }

        foreach ($this->correlateIncidents($signalsByEndpoint, $metrics, $baselines, $detectedAt) as $incident) {
            $fingerprint = $this->incidentFingerprint($incident);
            $seenFingerprints[$fingerprint] = true;

            if (isset($state['active_incidents'][$fingerprint])) {
                $state['active_incidents'][$fingerprint]['last_seen_at'] = $detectedAt->toIso8601String();
                continue;
            }

            $newIncidents[] = $incident;
            $alerts[] = $this->buildAlertPayload($incident);
            $incidents[] = $incident;
            $state['active_incidents'][$fingerprint] = [
                'incident_id' => $incident['incident_id'],
                'last_seen_at' => $detectedAt->toIso8601String(),
            ];
        }

        foreach ($state['active_incidents'] as $fingerprint => $activeIncident) {
            if (isset($seenFingerprints[$fingerprint])) {
                continue;
            }

            $state['active_incidents'][$fingerprint]['resolved_at'] = $detectedAt->toIso8601String();
            $this->resolveIncident($incidents, $activeIncident['incident_id'], $detectedAt);
            unset($state['active_incidents'][$fingerprint]);
        }

        $this->writeJsonFile($this->statePath, $state);
        $this->writeJsonFile($this->incidentsPath, $incidents);

        foreach ($alerts as $alert) {
            $this->emitAlert($alert);
        }

        return [
            'detected_at' => $detectedAt->toIso8601String(),
            'metrics' => $metrics,
            'baselines' => $baselines,
            'signals' => $signalsByEndpoint,
            'incidents' => $newIncidents,
            'alerts' => $alerts,
        ];
    }

    /**
     * @param  array<int, array<string, mixed>>  $history
     * @return array<string, float>
     */
    private function buildBaseline(array $history): array
    {
        if (count($history) < 3) {
            return [
                'average_latency' => 0.0,
                'request_rate' => 0.0,
                'error_rate' => 0.0,
                'sample_size' => (float) count($history),
            ];
        }

        return [
            'average_latency' => $this->trimmedAverage(array_column($history, 'average_latency')),
            'request_rate' => $this->trimmedAverage(array_column($history, 'request_rate')),
            'error_rate' => $this->trimmedAverage(array_column($history, 'error_rate')),
            'sample_size' => (float) count($history),
        ];
    }

    /**
     * @param  array<string, mixed>  $sample
     * @param  array<string, float>  $baseline
     * @param  array<string, array<string, mixed>>  $allMetrics
     * @return array<int, array<string, mixed>>
     */
    private function detectSignals(string $endpoint, array $sample, array $baseline, array $allMetrics): array
    {
        $signals = [];

        if (($baseline['sample_size'] ?? 0.0) >= 3) {
            if (
                $sample['average_latency'] > max(($baseline['average_latency'] * 3), 0.250)
                || $sample['latency_percentiles']['p95'] > max(($baseline['average_latency'] * 4), 0.500)
            ) {
                $signals[] = $this->makeSignal(
                    'latency',
                    $endpoint,
                    'average_latency',
                    $sample['average_latency'],
                    $baseline['average_latency'],
                    'Latency is above the learned baseline.'
                );
            }

            if (
                $sample['error_rate'] > max(0.10, ($baseline['error_rate'] * 3))
                && $sample['errors_per_second'] > 0.01
            ) {
                $signals[] = $this->makeSignal(
                    'error_rate',
                    $endpoint,
                    'error_rate',
                    $sample['error_rate'],
                    $baseline['error_rate'],
                    'Error rate crossed the endpoint threshold.'
                );
            }

            if ($sample['request_rate'] > max(($baseline['request_rate'] * 2), 0.2)) {
                $signals[] = $this->makeSignal(
                    'traffic',
                    $endpoint,
                    'request_rate',
                    $sample['request_rate'],
                    $baseline['request_rate'],
                    'Traffic rate spiked above the endpoint baseline.'
                );
            }
        }

        $peerErrorRates = [];
        foreach ($allMetrics as $peerEndpoint => $peerSample) {
            if ($peerEndpoint === $endpoint) {
                continue;
            }

            $peerErrorRates[] = (float) ($peerSample['error_rate'] ?? 0.0);
        }

        $peerMedianErrorRate = $this->median($peerErrorRates);
        if ($sample['error_rate'] >= 0.30 && $sample['error_rate'] > ($peerMedianErrorRate * 4)) {
            $signals[] = $this->makeSignal(
                'endpoint_specific',
                $endpoint,
                'error_rate',
                $sample['error_rate'],
                $peerMedianErrorRate,
                'This endpoint is failing much harder than its peers.'
            );
        }

        return $signals;
    }

    /**
     * @param  array<string, array<int, array<string, mixed>>>  $signalsByEndpoint
     * @param  array<string, array<string, mixed>>  $metrics
     * @param  array<string, array<string, float>>  $baselines
     * @return array<int, array<string, mixed>>
     */
    private function correlateIncidents(array $signalsByEndpoint, array $metrics, array $baselines, CarbonImmutable $detectedAt): array
    {
        $incidents = [];
        $serviceLatency = [];
        $serviceErrors = [];
        $serviceTraffic = [];

        foreach ($signalsByEndpoint as $endpoint => $signals) {
            foreach ($signals as $signal) {
                if ($signal['signal_type'] === 'latency') {
                    $serviceLatency[$endpoint][] = $signal;
                }

                if (in_array($signal['signal_type'], ['error_rate', 'endpoint_specific'], true)) {
                    $serviceErrors[$endpoint][] = $signal;
                }

                if ($signal['signal_type'] === 'traffic') {
                    $serviceTraffic[$endpoint][] = $signal;
                }
            }
        }

        if (count($serviceErrors) >= 2) {
            $incidents[] = $this->makeIncident(
                incidentType: 'ERROR_STORM',
                severity: 'critical',
                endpoints: array_keys($serviceErrors),
                signalsByEndpoint: $serviceErrors,
                metrics: $metrics,
                baselines: $baselines,
                detectedAt: $detectedAt,
                summary: 'Multiple endpoints are emitting elevated error rates at the same time.'
            );

            return $incidents;
        }

        if (count($serviceLatency) >= 2) {
            $incidents[] = $this->makeIncident(
                incidentType: 'SERVICE_DEGRADATION',
                severity: 'high',
                endpoints: array_keys($serviceLatency),
                signalsByEndpoint: $serviceLatency,
                metrics: $metrics,
                baselines: $baselines,
                detectedAt: $detectedAt,
                summary: 'Latency degradation is affecting multiple endpoints simultaneously.'
            );
        }

        if (count($serviceTraffic) >= 2) {
            $incidents[] = $this->makeIncident(
                incidentType: 'TRAFFIC_SURGE',
                severity: 'medium',
                endpoints: array_keys($serviceTraffic),
                signalsByEndpoint: $serviceTraffic,
                metrics: $metrics,
                baselines: $baselines,
                detectedAt: $detectedAt,
                summary: 'Traffic surged across multiple endpoints beyond the learned baseline.'
            );
        }

        foreach ($signalsByEndpoint as $endpoint => $signals) {
            if ($signals === []) {
                continue;
            }

            $signalTypes = array_values(array_unique(array_column($signals, 'signal_type')));

            if (in_array('endpoint_specific', $signalTypes, true) || in_array('error_rate', $signalTypes, true)) {
                $incidents[] = $this->makeIncident(
                    incidentType: 'LOCALIZED_ENDPOINT_FAILURE',
                    severity: in_array('endpoint_specific', $signalTypes, true) ? 'critical' : 'high',
                    endpoints: [$endpoint],
                    signalsByEndpoint: [$endpoint => $signals],
                    metrics: $metrics,
                    baselines: $baselines,
                    detectedAt: $detectedAt,
                    summary: sprintf('Endpoint %s is failing independently of the rest of the service.', $endpoint)
                );

                continue;
            }

            if (in_array('latency', $signalTypes, true)) {
                $incidents[] = $this->makeIncident(
                    incidentType: 'LATENCY_SPIKE',
                    severity: 'high',
                    endpoints: [$endpoint],
                    signalsByEndpoint: [$endpoint => $signals],
                    metrics: $metrics,
                    baselines: $baselines,
                    detectedAt: $detectedAt,
                    summary: sprintf('Endpoint %s exceeded its normal latency envelope.', $endpoint)
                );

                continue;
            }

            if (in_array('traffic', $signalTypes, true)) {
                $incidents[] = $this->makeIncident(
                    incidentType: 'TRAFFIC_SURGE',
                    severity: 'medium',
                    endpoints: [$endpoint],
                    signalsByEndpoint: [$endpoint => $signals],
                    metrics: $metrics,
                    baselines: $baselines,
                    detectedAt: $detectedAt,
                    summary: sprintf('Endpoint %s received a traffic surge.', $endpoint)
                );
            }
        }

        return $this->deduplicateIncidents($incidents);
    }

    /**
     * @param  array<int, array<string, mixed>>  $incidents
     * @return array<int, array<string, mixed>>
     */
    private function deduplicateIncidents(array $incidents): array
    {
        $unique = [];

        foreach ($incidents as $incident) {
            $unique[$this->incidentFingerprint($incident)] = $incident;
        }

        return array_values($unique);
    }

    /**
     * @param  array<string, array<int, array<string, mixed>>>  $signalsByEndpoint
     * @param  array<string, array<string, mixed>>  $metrics
     * @param  array<string, array<string, float>>  $baselines
     * @return array<string, mixed>
     */
    private function makeIncident(
        string $incidentType,
        string $severity,
        array $endpoints,
        array $signalsByEndpoint,
        array $metrics,
        array $baselines,
        CarbonImmutable $detectedAt,
        string $summary,
    ): array {
        $triggeringSignals = [];
        $baselineValues = [];
        $observedValues = [];

        foreach ($endpoints as $endpoint) {
            foreach ($signalsByEndpoint[$endpoint] ?? [] as $signal) {
                $triggeringSignals[] = $signal;
            }

            $baselineValues[$endpoint] = $baselines[$endpoint] ?? [];
            $observedValues[$endpoint] = $metrics[$endpoint] ?? [];
        }

        return [
            'incident_id' => (string) Str::uuid(),
            'incident_type' => $incidentType,
            'severity' => $severity,
            'status' => 'open',
            'detected_at' => $detectedAt->toIso8601String(),
            'affected_service' => $this->serviceName,
            'affected_endpoints' => array_values($endpoints),
            'triggering_signals' => $triggeringSignals,
            'baseline_values' => $baselineValues,
            'observed_values' => $observedValues,
            'summary' => $summary,
        ];
    }

    /**
     * @param  array<string, mixed>  $incident
     * @return array<string, string>
     */
    private function buildAlertPayload(array $incident): array
    {
        return [
            'incident_id' => $incident['incident_id'],
            'incident_type' => $incident['incident_type'],
            'severity' => $incident['severity'],
            'timestamp' => $incident['detected_at'],
            'summary' => $incident['summary'],
        ];
    }

    /**
     * @param  array<string, string>  $alert
     */
    private function emitAlert(array $alert): void
    {
        echo json_encode(['alert' => $alert], JSON_UNESCAPED_SLASHES).PHP_EOL;

        if ($this->webhookUrl === null || $this->webhookUrl === '') {
            return;
        }

        Http::timeout(3)->post($this->webhookUrl, $alert);
    }

    /**
     * @param  array<int, array<string, mixed>>  &$incidents
     */
    private function resolveIncident(array &$incidents, string $incidentId, CarbonImmutable $resolvedAt): void
    {
        foreach ($incidents as &$incident) {
            if (($incident['incident_id'] ?? null) !== $incidentId) {
                continue;
            }

            $incident['status'] = 'resolved';
            $incident['resolved_at'] = $resolvedAt->toIso8601String();
            break;
        }
    }

    /**
     * @param  array<string, mixed>  $sample
     * @return array<string, mixed>
     */
    private function normalizeSample(array $sample): array
    {
        return [
            'request_rate' => (float) ($sample['request_rate'] ?? 0.0),
            'error_rate' => (float) ($sample['error_rate'] ?? 0.0),
            'errors_per_second' => (float) ($sample['errors_per_second'] ?? 0.0),
            'average_latency' => (float) ($sample['average_latency'] ?? 0.0),
            'latency_percentiles' => [
                'p50' => (float) data_get($sample, 'latency_percentiles.p50', 0.0),
                'p95' => (float) data_get($sample, 'latency_percentiles.p95', 0.0),
                'p99' => (float) data_get($sample, 'latency_percentiles.p99', 0.0),
            ],
            'error_category_counters' => $sample['error_category_counters'] ?? [],
        ];
    }

    /**
     * @param  array<string, mixed>  $sample
     * @return array<string, mixed>
     */
    private function makeHistoryRecord(array $sample, CarbonImmutable $detectedAt): array
    {
        return [
            'timestamp' => $detectedAt->toIso8601String(),
            'request_rate' => $sample['request_rate'],
            'error_rate' => $sample['error_rate'],
            'average_latency' => $sample['average_latency'],
        ];
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function trimHistory(array $history): array
    {
        return array_slice(array_values($history), -1 * self::HISTORY_LIMIT);
    }

    /**
     * @param  float[]  $values
     */
    private function trimmedAverage(array $values): float
    {
        $values = array_values(array_filter($values, static fn ($value): bool => is_numeric($value)));

        if ($values === []) {
            return 0.0;
        }

        sort($values);

        if (count($values) >= 5) {
            array_shift($values);
            array_pop($values);
        }

        return array_sum($values) / count($values);
    }

    /**
     * @param  float[]  $values
     */
    private function median(array $values): float
    {
        $values = array_values(array_filter($values, static fn ($value): bool => is_numeric($value)));

        if ($values === []) {
            return 0.0;
        }

        sort($values);
        $count = count($values);
        $mid = intdiv($count, 2);

        if ($count % 2 === 0) {
            return ($values[$mid - 1] + $values[$mid]) / 2;
        }

        return $values[$mid];
    }

    /**
     * @param  array<string, mixed>  $incident
     */
    private function incidentFingerprint(array $incident): string
    {
        $endpoints = $incident['affected_endpoints'] ?? [];
        sort($endpoints);

        return sprintf('%s|%s', $incident['incident_type'], implode(',', $endpoints));
    }

    /**
     * @return array<string, mixed>
     */
    private function makeSignal(
        string $signalType,
        string $endpoint,
        string $metric,
        float $observedValue,
        float $baselineValue,
        string $reason,
    ): array {
        return [
            'signal_type' => $signalType,
            'endpoint' => $endpoint,
            'metric' => $metric,
            'observed' => round($observedValue, 6),
            'baseline' => round($baselineValue, 6),
            'reason' => $reason,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function emptyState(): array
    {
        return [
            'history' => [],
            'active_incidents' => [],
        ];
    }

    /**
     * @return array<int, mixed>|array<string, mixed>
     */
    private function readJsonFile(string $path, array $default): array
    {
        if (! is_file($path)) {
            return $default;
        }

        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? $decoded : $default;
    }

    /**
     * @param  array<int, mixed>|array<string, mixed>  $payload
     */
    private function writeJsonFile(string $path, array $payload): void
    {
        $directory = dirname($path);

        if (! is_dir($directory)) {
            mkdir($directory, 0777, true);
        }

        file_put_contents($path, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }
}
