<?php

namespace App\Providers;

use App\Services\AIOpsDetectionEngine;
use App\Services\AIOpsAutomationEngine;
use App\Services\PrometheusClient;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(PrometheusClient::class, function ($app): PrometheusClient {
            return new PrometheusClient(
                http: $app->make(HttpFactory::class),
                baseUrl: (string) config('services.aiops.prometheus_url', 'http://localhost:9090'),
                timeoutSeconds: (int) config('services.aiops.prometheus_timeout', 5),
            );
        });

        $this->app->singleton(AIOpsDetectionEngine::class, function (): AIOpsDetectionEngine {
            return new AIOpsDetectionEngine(
                statePath: storage_path('aiops/detector_state.json'),
                incidentsPath: storage_path('aiops/incidents.json'),
                serviceName: (string) config('services.aiops.service_name', config('app.name', 'laravel-api')),
                webhookUrl: config('services.aiops.webhook_url'),
            );
        });

        $this->app->singleton(AIOpsAutomationEngine::class, function (): AIOpsAutomationEngine {
            return new AIOpsAutomationEngine(
                incidentsPath: (string) config('aiops.incidents_path', storage_path('aiops/incidents.json')),
                responsesPath: (string) config('aiops.responses_path', storage_path('aiops/responses.json')),
                responseStatePath: (string) config('aiops.response_state_path', storage_path('aiops/response_state.json')),
                responsePolicies: (array) config('aiops.response_policies', []),
                escalationAction: (string) config('aiops.escalation_action', 'CRITICAL_ALERT'),
            );
        });
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
