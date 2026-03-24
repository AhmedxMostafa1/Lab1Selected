<?php

namespace App\Console\Commands;

use App\Services\AIOpsDetectionEngine;
use App\Services\PrometheusClient;
use Illuminate\Console\Command;
use Illuminate\Http\Client\RequestException;
use Throwable;

class AIOpsDetectCommand extends Command
{
    protected $signature = 'aiops:detect {--interval=20 : Seconds between detection cycles}';

    protected $description = 'Continuously query Prometheus, compute baselines, detect anomalies, and emit incidents.';

    public function __construct(
        private readonly PrometheusClient $prometheusClient,
        private readonly AIOpsDetectionEngine $detectionEngine,
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $interval = max(20, min(30, (int) $this->option('interval')));

        $this->info(sprintf('AIOps detector started. Polling every %d seconds.', $interval));

        while (true) {
            try {
                $metrics = $this->prometheusClient->fetchEndpointMetrics(AIOpsDetectionEngine::ENDPOINTS);
                $result = $this->detectionEngine->evaluate($metrics);

                $this->line(sprintf('[%s] Current endpoint metrics', $result['detected_at']));
                $this->table(
                    ['Endpoint', 'Req/s', 'Err %', 'Avg Lat s', 'P95 s', 'Signals'],
                    $this->buildRows($result['metrics'], $result['signals'])
                );

                if ($result['incidents'] !== []) {
                    foreach ($result['incidents'] as $incident) {
                        $this->error(sprintf(
                            'INCIDENT %s [%s] %s',
                            $incident['incident_id'],
                            $incident['severity'],
                            $incident['summary']
                        ));
                    }
                } else {
                    $this->info('No new incidents created in this cycle.');
                }
            } catch (RequestException $exception) {
                $this->warn('Prometheus query failed: '.$exception->getMessage());
            } catch (Throwable $exception) {
                $this->error('Detector cycle failed: '.$exception->getMessage());
            }

            sleep($interval);
        }
    }

    /**
     * @param  array<string, array<string, mixed>>  $metrics
     * @param  array<string, array<int, array<string, mixed>>>  $signals
     * @return array<int, array<int, string>>
     */
    private function buildRows(array $metrics, array $signals): array
    {
        $rows = [];

        foreach (AIOpsDetectionEngine::ENDPOINTS as $endpoint) {
            $sample = $metrics[$endpoint] ?? [];
            $endpointSignals = array_map(
                static fn (array $signal): string => $signal['signal_type'],
                $signals[$endpoint] ?? []
            );

            $rows[] = [
                $endpoint,
                number_format((float) ($sample['request_rate'] ?? 0.0), 3),
                number_format(((float) ($sample['error_rate'] ?? 0.0)) * 100, 2),
                number_format((float) ($sample['average_latency'] ?? 0.0), 3),
                number_format((float) data_get($sample, 'latency_percentiles.p95', 0.0), 3),
                $endpointSignals === [] ? 'normal' : implode(', ', $endpointSignals),
            ];
        }

        return $rows;
    }
}
