import { Module } from '@nestjs/common';
import { QoeService } from './qoe.service';

@Module({ providers: [QoeService], exports: [QoeService] })
export class QoeModule {}
