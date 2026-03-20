'use strict';
/**
 * OpenTelemetry initialization.
 * Activated when OTEL_EXPORTER_OTLP_ENDPOINT env var is set.
 * Must be required as the FIRST import in index.js (before any other require).
 */

let sdk = null;

function init() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // No-op when not configured

  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'medibook-api',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
      })],
    });

    sdk.start();
    console.log(`[Telemetry] OpenTelemetry initialized → ${endpoint}`);

    process.on('SIGTERM', () => sdk?.shutdown());
  } catch (err) {
    console.warn(`[Telemetry] OpenTelemetry init failed: ${err.message}. Install: npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http`);
  }
}

module.exports = { init };
