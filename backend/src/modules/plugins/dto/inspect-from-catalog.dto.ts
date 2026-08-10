import { IsNotEmpty, IsString } from 'class-validator';

export class InspectFromCatalogDto {
  @IsString()
  @IsNotEmpty()
  pluginId: string;

  @IsString()
  @IsNotEmpty()
  version: string;
}
