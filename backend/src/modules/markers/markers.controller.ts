import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { Media } from '../media/entities/media.entity';
import { MarkersService } from './markers.service';
import { CreateMarkerDto } from './dto/create-marker.dto';
import { UpdateMarkerDto } from './dto/update-marker.dto';

@Controller('markers')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class MarkersController {
  constructor(private readonly markers: MarkersService) {}

  @Get('episode/:episodeId')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  listForEpisode(@Param('episodeId', ParseIntPipe) episodeId: number) {
    return this.markers.findForEpisode(episodeId);
  }

  @Get('season/:seasonId')
  @CheckPolicies((ability) => ability.can(Action.Read, Media))
  listForSeason(@Param('seasonId', ParseIntPipe) seasonId: number) {
    return this.markers.findForSeason(seasonId);
  }

  @Post('season/:seasonId/detect')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  detectSeason(@Param('seasonId', ParseIntPipe) seasonId: number) {
    return this.markers.detectSeason(seasonId, 'manual');
  }

  @Post('series/:mediaId/detect-all')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  detectSeries(@Param('mediaId', ParseIntPipe) mediaId: number) {
    return this.markers.detectSeries(mediaId, 'manual');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  create(@Body() dto: CreateMarkerDto) {
    return this.markers.create(dto);
  }

  @Put(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMarkerDto) {
    return this.markers.update(id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, Media))
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.markers.remove(id);
  }
}
