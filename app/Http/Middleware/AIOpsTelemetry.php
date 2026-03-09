<?php

namespace App\Http\Middleware;

use App\Exceptions\Handler as ExceptionHandler;
use App\Support\PrometheusMetrics;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\Log;

class AIOpsTelemetry
{
    public function handle(Request $request, Closure $next)
    {
        $isMetricsEndpoint = $request->is('metrics');

        // 1. Correlation ID Propagation
        $requestId = $request->header('X-Request-Id', Str::uuid()->toString());
        $request->headers->set('X-Request-Id', $requestId);

        $startTime = microtime(true);

        // Process request
        $response = $next($request);

        // Add header to response
        $response->headers->set('X-Request-Id', $requestId);

        // Calculate Latency
        $latencyMs = (microtime(true) - $startTime) * 1000;

        // Skip logging and instrumentation for metrics scraping endpoint.
        if ($isMetricsEndpoint) {
            return $response;
        }

        $routePath = $this->resolvePathLabel($request);

        // 2. Central Error Categorization & Timeout Logic
        $errorCategory = ExceptionHandler::categorizeResponse($response, $latencyMs);
        $severity = $errorCategory === 'NONE' ? 'info' : 'error';
        $routeName = $request->route() ? $request->route()->getName() : null;
        $logLevel = $severity === 'error' ? 'error' : 'info';

        // 3. Stable Log Schema (Always emit these keys)
        $logData = [
            'timestamp'           => now()->toIso8601String(),
            'request_id'          => $requestId,
            'client_ip'           => $request->ip() ?? null,
            'user_agent'          => $request->userAgent() ?? null,
            'method'              => $request->method(),
            'path'                => $routePath,
            'query'               => $request->getQueryString() ?? null,
            'payload_size_bytes'  => $this->safeLength($request->getContent()),
            'response_size_bytes' => $this->safeLength($response->getContent()),
            'route_name'          => $routeName ?? 'unknown',
            'status_code'         => $response->getStatusCode(),
            'latency_ms'          => round($latencyMs, 2),
            'severity'            => $severity,
            'error_category'      => $errorCategory,
            'build_version'       => config('app.build_version'),
            'host'                => gethostname() ?: null,
        ];

        // Write to aiops.log as strict JSON
        Log::channel('aiops')->log($logLevel, 'telemetry', $logData);

        PrometheusMetrics::trackRequest(
            method: $request->method(),
            path: $routePath,
            statusCode: $response->getStatusCode(),
            durationSeconds: $latencyMs / 1000,
            errorCategory: $errorCategory
        );

        return $response;
    }

    private function resolvePathLabel(Request $request): string
    {
        $route = $request->route();
        if ($route && method_exists($route, 'uri')) {
            return '/'.ltrim($route->uri(), '/');
        }

        $path = ltrim($request->path(), '/');

        return $path === '' ? '/' : '/'.$path;
    }

    private function safeLength(string|false $content): int
    {
        if ($content === false) {
            return 0;
        }

        return strlen($content);
    }
}
