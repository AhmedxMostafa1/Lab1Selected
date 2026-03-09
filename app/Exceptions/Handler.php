<?php

namespace App\Exceptions;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Exceptions\Handler as ExceptionHandler;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class Handler extends ExceptionHandler
{
    public static function categorizeException(Throwable $exception): string
    {
        return match (true) {
            $exception instanceof ValidationException => 'VALIDATION_ERROR',
            $exception instanceof QueryException => 'DATABASE_ERROR',
            $exception instanceof HttpExceptionInterface && $exception->getStatusCode() >= 400 && $exception->getStatusCode() < 500 => 'UNKNOWN',
            default => 'SYSTEM_ERROR',
        };
    }

    public static function categorizeResponse(Response $response, float $latencyMs, float $timeoutThresholdMs = 4000.0): string
    {
        if ($latencyMs > $timeoutThresholdMs) {
            return 'TIMEOUT_ERROR';
        }

        $headerCategory = $response->headers->get('X-Error-Category');
        if (is_string($headerCategory) && $headerCategory !== '') {
            return $headerCategory;
        }

        $status = $response->getStatusCode();

        if ($status >= 500) {
            return 'SYSTEM_ERROR';
        }

        if ($status >= 400) {
            return 'UNKNOWN';
        }

        return 'NONE';
    }

    public static function renderApiException(Throwable $exception, Request $request): JsonResponse
    {
        $category = self::categorizeException($exception);
        $statusCode = 500;

        if ($exception instanceof ValidationException) {
            $statusCode = 422;
        } elseif ($exception instanceof HttpExceptionInterface) {
            $statusCode = $exception->getStatusCode();
        }

        $payload = [
            'message' => $exception->getMessage() !== '' ? $exception->getMessage() : 'Request failed.',
            'error_category' => $category,
            'request_id' => $request->header('X-Request-Id'),
        ];

        if ($exception instanceof ValidationException) {
            $payload['errors'] = $exception->errors();
        }

        return response()->json(
            $payload,
            $statusCode,
            ['X-Error-Category' => $category]
        );
    }
}
