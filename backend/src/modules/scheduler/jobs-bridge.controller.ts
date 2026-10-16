import {
  Body,
  Controller,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsString } from 'class-validator';
import type { Response } from 'express';
import { BridgeAuthGuard } from '../bridge/bridge-auth.guard';
import { PluginAutoUpdateService } from '../plugins/plugin-auto-update.service';
import { PluginCatalogClientService } from '../plugins/plugin-catalog-client.service';
import { PluginJobsService } from '../plugins/plugin-jobs.service';
import { ScheduledJobRegistry } from './scheduled-job-registry.service';

export class RunJobDto {
  @IsString()
  name!: string;
}

/** fliks-server lists and runs the jobs Nest still holds (server/docs/bridge.md); bridge-token auth only. Deleted at S8. */
@Controller('internal/jobs')
@UseGuards(BridgeAuthGuard)
export class JobsBridgeController {
  constructor(
    private readonly registry: ScheduledJobRegistry,
    private readonly pluginJobs: PluginJobsService,
    private readonly catalogClient: PluginCatalogClientService,
    private readonly pluginAutoUpdate: PluginAutoUpdateService,
  ) {}

  @Get()
  list() {
    const registered = this.registry.list().map((j) => ({
      name: j.name,
      cron: j.cron,
      triggerable: j.triggerable,
      labelKey: j.labelKey,
      pluginId: null,
    }));
    const declared = this.pluginJobs
      .listDeclared()
      .map(({ pluginId, job }) => ({
        name: job.name,
        cron: job.cron,
        triggerable: job.triggerable,
        labelKey: job.labelKey,
        pluginId,
      }));
    return { jobs: [...registered, ...declared] };
  }

  /** A core or registry job answers when it ends (204); a declared plugin job answers at once (202, 409, 400). */
  @Post('run')
  @HttpCode(204)
  async run(
    @Body() dto: RunJobDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string } | void> {
    try {
      if (dto.name === 'RefreshPluginSources') {
        await this.catalogClient.refreshAll();
        await this.pluginAutoUpdate.run();
        return;
      }
      const registered = this.registry.get(dto.name);
      if (registered) {
        await registered.run();
        return;
      }
    } catch (e) {
      throw new InternalServerErrorException((e as Error).message);
    }
    const declared = this.pluginJobs
      .listDeclared()
      .find((d) => d.job.name === dto.name);
    if (!declared) throw new NotFoundException(`unknown job ${dto.name}`);
    const result = this.pluginJobs.trigger(declared.pluginId, dto.name);
    if (result.ok) {
      res.status(202);
      return;
    }
    res.status(result.reason === 'already-running' ? 409 : 400);
    return { message: result.reason };
  }
}
