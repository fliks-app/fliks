import { BadRequestException, Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { PluginInstallService, PluginInspectReport, PluginInstallResult } from './plugin-install.service';
import { ConfirmImportDto } from './dto/confirm-import.dto';
import { MAX_ARCHIVE_COMPRESSED_BYTES } from './archive';

/** Manual-upload half of the install pipeline (`plans/plugin-system.plan.md`, "Manual upload"). */
@Controller('plugins/import')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PluginImportController {
  constructor(private readonly installService: PluginInstallService) {}

  @Post('inspect')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ARCHIVE_COMPRESSED_BYTES, files: 1, fields: 0, parts: 2 },
    }),
  )
  async inspect(@UploadedFile() file: Express.Multer.File): Promise<PluginInspectReport> {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.installService.inspectUpload(file.buffer);
  }

  @Post('confirm')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Settings'))
  async confirm(@Body() dto: ConfirmImportDto): Promise<PluginInstallResult> {
    return this.installService.confirmImport(dto);
  }
}
