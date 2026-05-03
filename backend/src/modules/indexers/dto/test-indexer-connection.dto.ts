import { IsObject, IsIn } from 'class-validator';

export class TestIndexerConnectionDto {
  @IsIn(['torznab'])
  implementation: 'torznab';

  @IsObject()
  settings: Record<string, unknown>;
}
