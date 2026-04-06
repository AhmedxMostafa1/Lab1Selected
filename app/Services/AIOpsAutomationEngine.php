<?php

namespace App\Services;

use Carbon\CarbonImmutable;

class AIOpsAutomationEngine
{
    /**
     * @param  array<string, array<string, string>>  $responsePolicies
     */
    public function __construct(
        private readonly string $incidentsPath,
        private readonly string $responsesPath,
        private readonly string $responseStatePath,
        private readonly array $responsePolicies,
        private readonly string $escalationAction = 'CRITICAL_ALERT',
    ) {
    }

    /**
     * @param  array<int, string>  $simulateFailures
     * @return array<string, mixed>
     */
    public function respond(?CarbonImmutable $processedAt = null, array $simulateFailures = []): array
    {
        $processedAt ??= CarbonImmutable::now();

        $incidents = $this->readJsonFile($this->incidentsPath, []);
        $responses = $this->readJsonFile($this->responsesPath, []);
        $state = $this->readJsonFile($this->responseStatePath, $this->emptyState());

        $actions = [];
        $processed = 0;
        $escalated = 0;
        $skipped = 0;

        foreach ($incidents as $incident) {
            if (($incident['status'] ?? 'open') !== 'open') {
                $skipped++;

                continue;
            }

            $incidentId = (string) ($incident['incident_id'] ?? '');
            if ($incidentId === '') {
                $skipped++;

                continue;
            }

            if (isset($state['escalated_incidents'][$incidentId])) {
                $skipped++;

                continue;
            }

            if (isset($state['responded_incidents'][$incidentId])) {
                $response = $this->logResponse(
                    $responses,
                    $incidentId,
                    $this->escalationAction,
                    $processedAt,
                    'success',
                    'Automated action already ran earlier and the incident is still open, so the engine escalated it.'
                );

                $state['escalated_incidents'][$incidentId] = [
                    'timestamp' => $response['timestamp'],
                    'reason' => 'persistent_anomaly',
                ];

                $actions[] = $response;
                $processed++;
                $escalated++;

                continue;
            }

            $policy = $this->policyFor((string) ($incident['incident_type'] ?? ''));
            $action = (string) $policy['action'];
            $actionResult = $this->executeAction($incident, $action, $policy, $simulateFailures);
            $response = $this->logResponse(
                $responses,
                $incidentId,
                $action,
                $processedAt,
                $actionResult['result'],
                $actionResult['notes']
            );

            $state['responded_incidents'][$incidentId] = [
                'timestamp' => $response['timestamp'],
                'action' => $action,
                'result' => $response['result'],
            ];

            $actions[] = $response;
            $processed++;

            if ($actionResult['result'] !== 'failed') {
                continue;
            }

            $escalation = $this->logResponse(
                $responses,
                $incidentId,
                $this->escalationAction,
                $processedAt,
                'success',
                'Automated response failed, so the engine escalated the incident for manual intervention.'
            );

            $state['escalated_incidents'][$incidentId] = [
                'timestamp' => $escalation['timestamp'],
                'reason' => 'automation_failure',
            ];

            $actions[] = $escalation;
            $processed++;
            $escalated++;
        }

        $this->writeJsonFile($this->responsesPath, $responses);
        $this->writeJsonFile($this->responseStatePath, $state);

        return [
            'processed_at' => $processedAt->toIso8601String(),
            'processed' => $processed,
            'escalated' => $escalated,
            'skipped' => $skipped,
            'actions' => $actions,
        ];
    }

    /**
     * @param  array<string, mixed>  $incident
     * @param  array<string, string>  $policy
     * @param  array<int, string>  $simulateFailures
     * @return array{result: string, notes: string}
     */
    private function executeAction(array $incident, string $action, array $policy, array $simulateFailures): array
    {
        $incidentType = (string) ($incident['incident_type'] ?? 'UNKNOWN');
        $shouldFail = in_array($incidentType, $simulateFailures, true);
        $service = (string) ($incident['affected_service'] ?? 'unknown-service');
        $endpoints = implode(', ', $incident['affected_endpoints'] ?? []);

        if ($shouldFail) {
            return [
                'result' => 'failed',
                'notes' => sprintf(
                    'Simulated %s for %s failed while handling %s on %s.',
                    str_replace('_', ' ', $action),
                    $service,
                    $incidentType,
                    $endpoints !== '' ? $endpoints : 'unknown endpoints'
                ),
            ];
        }

        return [
            'result' => 'success',
            'notes' => sprintf(
                '%s Targets: %s on %s.',
                (string) ($policy['notes'] ?? 'Simulated automated response executed.'),
                $service,
                $endpoints !== '' ? $endpoints : 'unknown endpoints'
            ),
        ];
    }

    /**
     * @param  array<int, array<string, mixed>>  &$responses
     * @return array<string, string>
     */
    private function logResponse(
        array &$responses,
        string $incidentId,
        string $actionTaken,
        CarbonImmutable $processedAt,
        string $result,
        string $notes,
    ): array {
        $record = [
            'incident_id' => $incidentId,
            'action_taken' => $actionTaken,
            'timestamp' => $processedAt->toIso8601String(),
            'result' => $result,
            'notes' => $notes,
        ];

        $responses[] = $record;

        return $record;
    }

    /**
     * @return array<string, string>
     */
    private function policyFor(string $incidentType): array
    {
        return $this->responsePolicies[$incidentType] ?? [
            'action' => 'send_alert',
            'notes' => 'Simulated fallback notification because no explicit response policy was configured.',
        ];
    }

    /**
     * @return array<string, array<string, array<string, string>>>
     */
    private function emptyState(): array
    {
        return [
            'responded_incidents' => [],
            'escalated_incidents' => [],
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
