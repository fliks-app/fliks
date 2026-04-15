import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { ImageService, ImageType, MediaImageVariant } from './image.service';

@Controller('images')
export class ImageController {
  constructor(private readonly imageService: ImageService) {}

  @Get(':type/:id/:variant')
  serveWithVariant(
    @Param('type') type: string,
    @Param('id') id: string,
    @Param('variant') variant: string,
    @Res() res: Response,
  ) {
    return this.serve(type, id, variant, res);
  }

  @Get(':type/:id')
  serveWithoutVariant(
    @Param('type') type: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    return this.serve(type, id, undefined, res);
  }

  private serve(
    type: string,
    id: string,
    variant: string | undefined,
    res: Response,
  ) {
    const validTypes = ['media', 'person', 'episode'];
    if (!validTypes.includes(type)) throw new NotFoundException();

    const filePath = this.imageService.getDiskPath(
      type as ImageType,
      +id,
      variant as MediaImageVariant | undefined,
    );

    if (!existsSync(filePath)) throw new NotFoundException();

    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  }
}
