<?php

namespace App\Console\Commands;

use App\Services\AIOpsAutomationEngine;
use Illuminate\Console\Command;
use Throwable;

class AIOpsRespondCommand extends Command
{
    protected $signature = 'aiops:respond
        {--watch : Continuously monitor incident records and react to new or persistent incidents}
        {--interval=20 : Seconds between response cycles in watch mode}
        {--simulate-failure=* : Incident types whose automated action should fail for demonstration}';

    protected $description = 'Monitor incident records, execute automated response policies, and escalate when needed.';

    public function __construct(
        private readonly AIOpsAutomationEngine $automationEngine,
    ) {
        parent::__construct();
    }

    public function handle(): int
    {
        $watch = (bool) $this->option('watch');
        $interval = max(5, (int) $this->option('interval'));

        if (! $watch) {
            return $this->runCycle();
        }

        $this->info(sprintf('AIOps automation engine started. Polling every %d seconds.', $interval));

        while (true) {
            $exitCode = $this->runCycle();
            if ($exitCode !== self::SUCCESS) {
                return $exitCode;
            }

            sleep($interval);
        }
    }

    private function runCycle(): int
    {
        try {
            $result = $this->automationEngine->respond(simulateFailures: (array) $this->option('simulate-failure'));

            $this->line(sprintf('[%s] Automation cycle complete', $result['processed_at']));

            if ($result['actions'] === []) {
                $this->info('No open incidents required action.');

                return self::SUCCESS;
            }

            $this->table(
                ['Incident ID', 'Action', 'Result', 'Notes'],
                array_map(
                    static fn (array $action): array => [
                        $action['incident_id'],
                        $action['action_taken'],
                        $action['result'],
                        $action['notes'],
                    ],
                    $result['actions']
                )
            );

            $this->info(sprintf(
                'Processed %d action(s); escalated %d incident(s); skipped %d incident(s).',
                $result['processed'],
                $result['escalated'],
                $result['skipped']
            ));

            return self::SUCCESS;
        } catch (Throwable $exception) {
            $this->error('Automation cycle failed: '.$exception->getMessage());

            return self::FAILURE;
        }
    }
}
