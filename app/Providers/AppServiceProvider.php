<?php

namespace App\Providers;

use App\Services\AIOpsDetectionEngine;
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
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
