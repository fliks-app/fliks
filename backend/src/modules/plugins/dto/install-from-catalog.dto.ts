import { IsNotEmpty, IsString } from 'class-validator';

export class InstallFromCatalogDto {
  @IsString()
  @IsNotEmpty()
  pluginId: string;

  @IsString()
  @IsNotEmpty()
  version: string;
}
