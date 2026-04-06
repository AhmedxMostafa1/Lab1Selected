<?php

return [
    'incidents_path' => storage_path('aiops/incidents.json'),
    'responses_path' => storage_path('aiops/responses.json'),
    'response_state_path' => storage_path('aiops/response_state.json'),
    'watch_interval' => (int) env('AIOPS_RESPONSE_INTERVAL', 20),
    'escalation_action' => env('AIOPS_ESCALATION_ACTION', 'CRITICAL_ALERT'),
    'response_policies' => [
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
        'SERVICE_DEGRADATION' => [
            'action' => 'restart_service',
            'notes' => 'Simulated service recycle to clear multi-endpoint degradation.',
        ],
        'LOCALIZED_ENDPOINT_FAILURE' => [
            'action' => 'traffic_throttling',
            'notes' => 'Simulated traffic throttling to isolate a failing endpoint.',
        ],
    ],
];
