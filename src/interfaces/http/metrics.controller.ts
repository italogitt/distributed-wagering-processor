import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Registry } from 'prom-client';

export const METRICS = Symbol('METRICS');
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('content-type', Registry.PROMETHEUS_CONTENT_TYPE)
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
