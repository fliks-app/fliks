import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { PersonsService } from './persons.service';

@Controller('persons')
export class PersonsController {
  constructor(private readonly persons: PersonsService) {}

  @Get('search')
  search(@Query('q') query: string) {
    return this.persons.search(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.persons.findOne(id);
  }

  @Get(':id/provider-credits')
  getProviderCredits(@Param('id', ParseIntPipe) id: number) {
    return this.persons.getProviderCredits(id);
  }
}
