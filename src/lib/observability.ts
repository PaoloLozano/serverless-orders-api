import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';

/**
 * Powertools for AWS Lambda.
 * - Logger: structured JSON logs (searchable in CloudWatch Logs Insights).
 * - Metrics: custom CloudWatch metrics written as Embedded Metric Format (EMF) log lines,
 *   so publishing a metric costs no extra API call or latency.
 * Service name and namespace come from POWERTOOLS_SERVICE_NAME / POWERTOOLS_METRICS_NAMESPACE.
 */
export const logger = new Logger();
export const metrics = new Metrics();
