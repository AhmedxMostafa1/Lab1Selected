<?php

namespace Tests\Unit;

use App\Services\AIOpsDetectionEngine;
use Carbon\CarbonImmutable;
use Tests\TestCase;

class AIOpsDetectionEngineTest extends TestCase
{
    public function test_it_creates_and_suppresses_duplicate_incidents(): void
    {
        $directory = storage_path('framework/testing/aiops');
        $statePath = $directory.'/detector_state.json';
        $incidentsPath = $directory.'/incidents.json';

        @mkdir($directory, 0777, true);
        @unlink($statePath);
        @unlink($incidentsPath);

        $engine = new AIOpsDetectionEngine($statePath, $incidentsPath, 'lab-service');
        $baselineMetrics = $this->normalMetrics();

        for ($i = 0; $i < 5; $i++) {
            $result = $engine->evaluate($baselineMetrics, CarbonImmutable::parse("2026-03-24 10:0{$i}:00"));
            $this->assertCount(0, $result['incidents']);
        }

        $anomalyMetrics = $this->normalMetrics();
        $anomalyMetrics['/api/error']['error_rate'] = 0.95;
        $anomalyMetrics['/api/error']['errors_per_second'] = 0.80;
        $anomalyMetrics['/api/error']['error_category_counters'] = ['SYSTEM_ERROR' => 9];

        $firstIncident = $engine->evaluate($anomalyMetrics, CarbonImmutable::parse('2026-03-24 10:10:00'));
        $secondIncident = $engine->evaluate($anomalyMetrics, CarbonImmutable::parse('2026-03-24 10:10:20'));

        $this->assertCount(1, $firstIncident['incidents']);
        $this->assertSame('LOCALIZED_ENDPOINT_FAILURE', $firstIncident['incidents'][0]['incident_type']);
        $this->assertCount(1, $firstIncident['alerts']);
        $this->assertCount(0, $secondIncident['incidents']);
        $this->assertCount(0, $secondIncident['alerts']);
    }

    public function test_it_resolves_incidents_after_recovery(): void
    {
        $directory = storage_path('framework/testing/aiops-resolution');
        $statePath = $directory.'/detector_state.json';
        $incidentsPath = $directory.'/incidents.json';

        @mkdir($directory, 0777, true);
        @unlink($statePath);
        @unlink($incidentsPath);

        $engine = new AIOpsDetectionEngine($statePath, $incidentsPath, 'lab-service');
        $baselineMetrics = $this->normalMetrics();

        for ($i = 0; $i < 5; $i++) {
            $engine->evaluate($baselineMetrics, CarbonImmutable::parse("2026-03-24 11:0{$i}:00"));
        }

        $anomalyMetrics = $this->normalMetrics();
        $anomalyMetrics['/api/slow']['average_latency'] = 1.5;
        $anomalyMetrics['/api/slow']['latency_percentiles']['p95'] = 2.4;

        $engine->evaluate($anomalyMetrics, CarbonImmutable::parse('2026-03-24 11:10:00'));
        $engine->evaluate($baselineMetrics, CarbonImmutable::parse('2026-03-24 11:10:20'));

        $incidents = json_decode((string) file_get_contents($incidentsPath), true);

        $this->assertSame('resolved', $incidents[0]['status']);
        $this->assertArrayHasKey('resolved_at', $incidents[0]);
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private function normalMetrics(): array
    {
        $metrics = [];

        foreach (AIOpsDetectionEngine::ENDPOINTS as $endpoint) {
            $metrics[$endpoint] = [
                'request_rate' => 1.2,
                'error_rate' => 0.01,
                'errors_per_second' => 0.0,
                'average_latency' => $endpoint === '/api/slow' ? 0.20 : 0.05,
                'latency_percentiles' => [
                    'p50' => 0.03,
                    'p95' => $endpoint === '/api/slow' ? 0.30 : 0.08,
                    'p99' => $endpoint === '/api/slow' ? 0.40 : 0.10,
                ],
                'error_category_counters' => [],
            ];
        }

        return $metrics;
    }
}
