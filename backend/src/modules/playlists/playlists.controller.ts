import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlaylistsService } from './playlists.service';
import { CreatePlaylistDto } from './dto/create-playlist.dto';
import { UpdatePlaylistDto } from './dto/update-playlist.dto';
import { AddPlaylistItemDto } from './dto/add-playlist-item.dto';
import { ReorderPlaylistItemsDto } from './dto/reorder-playlist-items.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { PoliciesGuard } from '../auth/casl/policies.guard';
import { CheckPolicies } from '../auth/casl/check-policies.decorator';
import { Action } from '../auth/casl/actions.enum';
import { User } from '../users/entities/user.entity';
import { Playlist } from './entities/playlist.entity';

/**
 * The class-level policies only gate "may use playlists at all" (granted to
 * every authenticated user). The real per-playlist role enforcement
 * (owner/administrator/editor/viewer) lives in {@link PlaylistsService}.
 */
@Controller('playlists')
@UseGuards(JwtOrApiKeyGuard, PoliciesGuard)
export class PlaylistsController {
  constructor(private readonly service: PlaylistsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, Playlist))
  findMine(@Req() req: Request) {
    return this.service.findAccessibleForUser(req.user as User);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Create, Playlist))
  create(@Req() req: Request, @Body() dto: CreatePlaylistDto) {
    return this.service.create(req.user as User, dto);
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, Playlist))
  findOne(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.service.findOneForUser(req.user as User, id);
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Update, Playlist))
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePlaylistDto,
  ) {
    return this.service.update(req.user as User, id, dto);
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Delete, Playlist))
  remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.service.remove(req.user as User, id);
  }

  @Get(':id/items')
  @CheckPolicies((ability) => ability.can(Action.Read, Playlist))
  getItems(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.service.getItems(req.user as User, id);
  }

  @Post(':id/items')
  @CheckPolicies((ability) => ability.can(Action.Update, Playlist))
  addItem(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddPlaylistItemDto,
  ) {
    return this.service.addItem(req.user as User, id, dto);
  }

  @Put(':id/items/order')
  @CheckPolicies((ability) => ability.can(Action.Update, Playlist))
  reorder(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReorderPlaylistItemsDto,
  ) {
    return this.service.reorder(req.user as User, id, dto);
  }

  @Delete(':id/items/by-media/:mediaId')
  @CheckPolicies((ability) => ability.can(Action.Update, Playlist))
  removeItemsByMedia(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    return this.service.removeItemsByMedia(req.user as User, id, mediaId);
  }

  @Delete(':id/items/:itemId')
  @CheckPolicies((ability) => ability.can(Action.Update, Playlist))
  removeItem(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
  ) {
    return this.service.removeItem(req.user as User, id, itemId);
  }
}
