<?php

namespace Tests\Unit;

use App\Services\AIOpsAutomationEngine;
use Carbon\CarbonImmutable;
use Tests\TestCase;

class AIOpsAutomationEngineTest extends TestCase
{
    public function test_it_executes_a_policy_and_logs_the_response(): void
    {
        $directory = storage_path('framework/testing/aiops-automation');
        $incidentsPath = $directory.'/incidents.json';
        $responsesPath = $directory.'/responses.json';
        $statePath = $directory.'/response_state.json';

        @mkdir($directory, 0777, true);
        @unlink($responsesPath);
        @unlink($statePath);

        file_put_contents($incidentsPath, json_encode([
            $this->makeIncident('incident-1', 'LATENCY_SPIKE'),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $engine = $this->makeEngine($incidentsPath, $responsesPath, $statePath);
        $result = $engine->respond(CarbonImmutable::parse('2026-04-06 18:00:00'));
        $responses = json_decode((string) file_get_contents($responsesPath), true);

        $this->assertSame(1, $result['processed']);
        $this->assertSame(0, $result['escalated']);
        $this->assertCount(1, $responses);
        $this->assertSame('incident-1', $responses[0]['incident_id']);
        $this->assertSame('restart_service', $responses[0]['action_taken']);
        $this->assertSame('success', $responses[0]['result']);
    }

    public function test_it_escalates_when_an_incident_persists_after_the_first_response(): void
    {
        $directory = storage_path('framework/testing/aiops-automation-persist');
        $incidentsPath = $directory.'/incidents.json';
        $responsesPath = $directory.'/responses.json';
        $statePath = $directory.'/response_state.json';

        @mkdir($directory, 0777, true);
        @unlink($responsesPath);
        @unlink($statePath);

        file_put_contents($incidentsPath, json_encode([
            $this->makeIncident('incident-2', 'TRAFFIC_SURGE'),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $engine = $this->makeEngine($incidentsPath, $responsesPath, $statePath);
        $engine->respond(CarbonImmutable::parse('2026-04-06 18:05:00'));
        $result = $engine->respond(CarbonImmutable::parse('2026-04-06 18:06:00'));
        $responses = json_decode((string) file_get_contents($responsesPath), true);

        $this->assertSame(1, $result['processed']);
        $this->assertSame(1, $result['escalated']);
        $this->assertCount(2, $responses);
        $this->assertSame('scale_service', $responses[0]['action_taken']);
        $this->assertSame('CRITICAL_ALERT', $responses[1]['action_taken']);
    }

    public function test_it_escalates_immediately_when_the_automated_action_fails(): void
    {
        $directory = storage_path('framework/testing/aiops-automation-failure');
        $incidentsPath = $directory.'/incidents.json';
        $responsesPath = $directory.'/responses.json';
        $statePath = $directory.'/response_state.json';

        @mkdir($directory, 0777, true);
        @unlink($responsesPath);
        @unlink($statePath);

        file_put_contents($incidentsPath, json_encode([
            $this->makeIncident('incident-3', 'ERROR_STORM'),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $engine = $this->makeEngine($incidentsPath, $responsesPath, $statePath);
        $result = $engine->respond(
            CarbonImmutable::parse('2026-04-06 18:10:00'),
            ['ERROR_STORM']
        );
        $responses = json_decode((string) file_get_contents($responsesPath), true);

        $this->assertSame(2, $result['processed']);
        $this->assertSame(1, $result['escalated']);
        $this->assertCount(2, $responses);
        $this->assertSame('send_alert', $responses[0]['action_taken']);
        $this->assertSame('failed', $responses[0]['result']);
        $this->assertSame('CRITICAL_ALERT', $responses[1]['action_taken']);
    }

    private function makeEngine(string $incidentsPath, string $responsesPath, string $statePath): AIOpsAutomationEngine
    {
        return new AIOpsAutomationEngine(
            incidentsPath: $incidentsPath,
            responsesPath: $responsesPath,
            responseStatePath: $statePath,
            responsePolicies: [
                'LATENCY_SPIKE' => [
                    'action' => 'restart_service',
                    'notes' => 'Simulated application service restart to recover high latency.',
                ],
                'ERROR_STORM' => [
                    'action' => 'send_alert',
                    'notes' => 'Simulated on-call alert delivery for widespread error conditions.',
                ],
                'TRAFFIC_SURGE' => [
                    'action' => 'scale_service',
                    'notes' => 'Simulated horizontal scale-out for elevated traffic demand.',
                ],
            ],
            escalationAction: 'CRITICAL_ALERT',
        );
    }

    /**
     * @return array<string, mixed>
     */
    private function makeIncident(string $incidentId, string $incidentType): array
    {
        return [
            'incident_id' => $incidentId,
            'incident_type' => $incidentType,
            'severity' => 'high',
            'status' => 'open',
            'detected_at' => '2026-04-06T18:00:00+00:00',
            'affected_service' => 'lab-service',
            'affected_endpoints' => ['/api/test'],
            'triggering_signals' => [],
            'baseline_values' => [],
            'observed_values' => [],
            'summary' => 'Synthetic incident for automation tests.',
        ];
    }
}
