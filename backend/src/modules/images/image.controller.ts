import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'fs';
import {
  ImageService,
  ImageSize,
  ImageType,
  MediaImageVariant,
} from './image.service';

const VALID_SIZES: ImageSize[] = ['thumb', 'medium', 'full'];

@Controller('images')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  @Get(':type/:id/:variant')
  serveWithVariant(
    @Param('type') type: string,
    @Param('id') id: string,
    @Param('variant') variant: string,
    @Query('size') size: string | undefined,
    @Res() res: Response,
  ) {
    return this.serve(type, id, variant, size, res);
  }

  @Get(':type/:id')
  serveWithoutVariant(
    @Param('type') type: string,
    @Param('id') id: string,
    @Query('size') size: string | undefined,
    @Res() res: Response,
  ) {
    return this.serve(type, id, undefined, size, res);
  }

  private serve(
    type: string,
    id: string,
    variant: string | undefined,
    sizeRaw: string | undefined,
    res: Response,
  ) {
    const validTypes = ['media', 'person', 'episode', 'season', 'request'];
    if (!validTypes.includes(type)) throw new NotFoundException();

    // Request art is keyed by `{mediaType}-{tmdbId}`; everything else by a
    // numeric id. The strict pattern doubles as path-traversal protection,
    // since the string key lands in a filesystem path.
    let idArg: number | string;
    if (type === 'request') {
      if (!/^(movie|series)-\d+$/.test(id)) throw new NotFoundException();
      idArg = id;
    } else {
      idArg = +id;
    }

    const size: ImageSize = (VALID_SIZES as string[]).includes(sizeRaw ?? '')
      ? (sizeRaw as ImageSize)
      : 'full';

    let filePath = this.imageService.getDiskPath(
      type as ImageType,
      idArg,
      variant as MediaImageVariant | undefined,
      size,
    );

    // Fall back to `full` when the requested size hasn't been generated yet
    // (e.g. images downloaded before multi-size support, or non-TMDB sources
    // that only yield a single file).
    if (!existsSync(filePath) && size !== 'full') {
      filePath = this.imageService.getDiskPath(
        type as ImageType,
        idArg,
        variant as MediaImageVariant | undefined,
        'full',
      );
    }

    if (!existsSync(filePath)) throw new NotFoundException();

    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  }
}
